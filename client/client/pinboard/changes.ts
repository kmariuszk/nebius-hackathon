import { atom, type Atom } from 'tldraw'
import type { LinkKind } from '../../shared/ids.ts'
import { chatBus, chatTurns, type AskRequest, type TurnEnd } from '../chat/chatBus.ts'

// This viewer's own edits since their last Update suggestions (T13), kept per board in
// sessionStorage: the toolbar's "N changes · the agent is waiting", its list in plain words, and
// the JSON the agent reads as <board-changes> (the tldraw://<boardId>/changes resource,
// harness/harness/acp/mapping.py). Repeated changes to the same thing collapse.

export type Decision = 'keep' | 'discard' | null

type LinkChange = { from: string; to: string; kind: LinkKind; label?: string }

export type Change =
	| { type: 'moved'; paperId: string }
	| ({ type: 'link_added' | 'link_renamed' | 'link_hidden' | 'link_removed' } & LinkChange)
	| { type: 'note_added'; noteId: string; text: string; paperId?: string }
	| { type: 'note_pinned'; noteId: string; text: string; paperId: string }
	| { type: 'voted'; paperId: string; decision: Decision }
	| { type: 'cluster_renamed'; clusterId: string; label: string }

export interface Entry {
	/** What it's a change to (subjectOf): changes to one thing collapse. */
	key: string
	change: Change
	at: string
	/** The arrow a link change was made on, so undo and redo can take the change back; never sent to the agent. */
	shapeId?: string
}

export interface ChangesState {
	since: string
	entries: Entry[]
}

export function subjectOf(change: Change): string {
	switch (change.type) {
		case 'moved':
		case 'voted':
			return `${change.type} ${change.paperId}`
		case 'cluster_renamed':
			return `cluster ${change.clusterId}`
		case 'note_added':
		case 'note_pinned':
			return `note ${change.noteId}`
		default:
			return `link ${change.kind} ${change.from} ${change.to}`
	}
}

const same = (a: Change, b: Change) => JSON.stringify(a) === JSON.stringify(b)

// the target entry with a new change; the same array when nothing changes, so nothing is saved
function put(entries: readonly Entry[], target: Entry, change: Change, at: string): Entry[] {
	if (same(target.change, change)) return entries as Entry[]
	return entries.map((e) => (e === target ? { ...target, change, at } : e))
}

/**
 * Adds a change, collapsing it with earlier ones to the same thing: the latest move, vote or name
 * wins; naming a link you drew names that one change; a link you drew and deleted, or a note you
 * added and then pinned, is one change or none.
 */
export function addChange(entries: readonly Entry[], change: Change, at: string, shapeId?: string): Entry[] {
	const key = subjectOf(change)
	const entry: Entry = shapeId ? { key, change, at, shapeId } : { key, change, at }
	const earlier = entries.filter((e) => e.key === key)
	const added = earlier.find((e) => e.change.type === 'link_added' || e.change.type === 'note_added')
	switch (change.type) {
		case 'link_removed':
			// drawn and deleted since the last update: nothing for the agent to catch up on
			if (added) return entries.filter((e) => e.key !== key)
			return [...entries.filter((e) => e.key !== key), entry]
		case 'link_renamed':
			if (added) return put(entries, added, { ...added.change, label: change.label } as Change, at)
			break
		case 'note_pinned':
			if (added) return put(entries, added, { ...added.change, paperId: change.paperId } as Change, at)
			break
	}
	const prev = earlier.find((e) => e.change.type === change.type)
	if (prev) return put(entries, prev, change, at)
	return [...entries, entry]
}

const without = (entries: readonly Entry[], drop: (e: Entry) => boolean): Entry[] =>
	entries.some(drop) ? entries.filter((e) => !drop(e)) : (entries as Entry[])

/** A link's arrow is on the board and showing again (undo, redo, or un-hidden): deleting or hiding it is no longer a change. */
export function linkShapeBack(entries: readonly Entry[], shapeId: string): Entry[] {
	return without(entries, (e) => e.shapeId === shapeId && (e.change.type === 'link_removed' || e.change.type === 'link_hidden'))
}

/** A link's arrow left the board (undo of drawing it): drawing it is no longer a change. */
export function linkShapeGone(entries: readonly Entry[], shapeId: string): Entry[] {
	return without(entries, (e) => e.shapeId === shapeId && e.change.type === 'link_added')
}

interface ShapeLike {
	type: string
	x: number
	y: number
	parentId: string
	props: object
	meta: Record<string, unknown>
}

/** What a person's change to a shape is, for the agent: a paper moved, or a cluster renamed. */
export function shapeEdit(prev: ShapeLike, next: ShapeLike): Change | null {
	const props = next.props as { paperId?: unknown; name?: unknown }
	if (next.type === 'paper-card' && typeof props.paperId === 'string') {
		const moved = prev.x !== next.x || prev.y !== next.y || prev.parentId !== next.parentId
		return moved ? { type: 'moved', paperId: props.paperId } : null
	}
	const clusterId = next.meta.clusterId
	if (next.type === 'frame' && typeof clusterId === 'string' && typeof props.name === 'string') {
		const renamed = (prev.props as { name?: unknown }).name !== props.name
		return renamed ? { type: 'cluster_renamed', clusterId, label: props.name } : null
	}
	return null
}

/** A note's text as the person types it, in the changes about that note. */
export function noteText(entries: readonly Entry[], noteId: string, text: string): Entry[] {
	const key = `note ${noteId}`
	if (!entries.some((e) => e.key === key && 'text' in e.change && e.change.text !== text)) return entries as Entry[]
	return entries.map((e) => (e.key === key ? { ...e, change: { ...e.change, text } as Change } : e))
}

/** A note dragged off its paper: it's no longer pinned there. */
export function noteUnpinned(entries: readonly Entry[], noteId: string): Entry[] {
	const key = `note ${noteId}`
	if (!entries.some((e) => e.key === key)) return entries as Entry[]
	return entries.flatMap((e) => {
		if (e.key !== key) return [e]
		if (e.change.type === 'note_pinned') return []
		if (e.change.type !== 'note_added') return [e]
		const { paperId: _, ...free } = e.change
		return [{ ...e, change: free }]
	})
}

/** A note deleted: changes about it go too. */
export function noteDeleted(entries: readonly Entry[], noteId: string): Entry[] {
	const key = `note ${noteId}`
	return entries.some((e) => e.key === key) ? entries.filter((e) => e.key !== key) : (entries as Entry[])
}

/** The <board-changes> JSON: `{since, changes: [{type, …, at}]}`. */
export function changesJson(state: ChangesState): string {
	const changes = state.entries.map(({ change, at }) => {
		const { noteId: _, ...rest } = change as Change & { noteId?: string }
		return { ...rest, at }
	})
	return JSON.stringify({ since: state.since, changes })
}

/** A change in plain words, for the toolbar's list. */
export function describeChange(change: Change, labelOf: (paperId: string) => string): string {
	switch (change.type) {
		case 'moved':
			return `You moved ${labelOf(change.paperId)}`
		case 'voted': {
			const paper = labelOf(change.paperId)
			if (change.decision === 'keep') return `You kept ${paper}`
			if (change.decision === 'discard') return `You discarded ${paper}`
			return `You took back your vote on ${paper}`
		}
		case 'note_added':
			return change.paperId ? `You added a note on ${labelOf(change.paperId)}` : 'You added a note'
		case 'note_pinned':
			return `You pinned a note to ${labelOf(change.paperId)}`
		case 'cluster_renamed':
			return `You renamed a cluster “${change.label}”`
	}
	const pair = `${labelOf(change.from)} – ${labelOf(change.to)}`
	switch (change.type) {
		case 'link_added':
			return `You linked ${labelOf(change.from)} and ${labelOf(change.to)}${change.label ? ` as “${change.label}”` : ''}`
		case 'link_renamed':
			return change.label ? `You named the link ${pair} “${change.label}”` : `You took the name off the link ${pair}`
		case 'link_hidden':
			return `You hid the link ${pair}`
		case 'link_removed':
			return `You deleted the link ${pair}`
	}
}

// ---- per board, in sessionStorage

export interface StorageLike {
	getItem(key: string): string | null
	setItem(key: string, value: string): void
}

const isState = (v: unknown): v is ChangesState =>
	!!v && typeof (v as ChangesState).since === 'string' && Array.isArray((v as ChangesState).entries)

export function createChanges(storage: StorageLike | null, now = () => new Date().toISOString()) {
	const atoms = new Map<string, Atom<ChangesState>>()
	const keyOf = (boardId: string) => `pinboard-changes:${boardId}`
	const load = (boardId: string): ChangesState => {
		try {
			const saved = JSON.parse(storage?.getItem(keyOf(boardId)) ?? 'null')
			if (isState(saved)) return saved
		} catch {
			// a broken entry starts over
		}
		return { since: now(), entries: [] }
	}
	const of = (boardId: string) => {
		let a = atoms.get(boardId)
		if (!a) atoms.set(boardId, (a = atom(`changes ${boardId}`, load(boardId))))
		return a
	}
	const save = (boardId: string, next: ChangesState) => {
		of(boardId).set(next)
		try {
			storage?.setItem(keyOf(boardId), JSON.stringify(next))
		} catch {
			// without storage the changes last until the page reloads
		}
	}
	const edit = (boardId: string, fn: (entries: readonly Entry[]) => Entry[]) => {
		const current = of(boardId).get()
		const entries = fn(current.entries)
		if (entries !== current.entries) save(boardId, { ...current, entries })
	}
	return {
		/** Reactive, for useValue. */
		get: (boardId: string) => of(boardId).get(),
		/** Records a change; the function it returns puts the changes about that thing back as they were (Undo). */
		record(boardId: string, change: Change, shapeId?: string): () => void {
			const key = subjectOf(change)
			const before = of(boardId).get().entries.filter((e) => e.key === key)
			edit(boardId, (entries) => addChange(entries, change, now(), shapeId))
			return () => edit(boardId, (entries) => [...entries.filter((e) => e.key !== key), ...before])
		},
		noteText: (boardId: string, noteId: string, text: string) => edit(boardId, (e) => noteText(e, noteId, text)),
		noteUnpinned: (boardId: string, noteId: string) => edit(boardId, (e) => noteUnpinned(e, noteId)),
		noteDeleted: (boardId: string, noteId: string) => edit(boardId, (e) => noteDeleted(e, noteId)),
		linkShapeBack: (boardId: string, shapeId: string) => edit(boardId, (e) => linkShapeBack(e, shapeId)),
		linkShapeGone: (boardId: string, shapeId: string) => edit(boardId, (e) => linkShapeGone(e, shapeId)),
		/** The changes as <board-changes> JSON, and a fresh start for the next Update suggestions. */
		take(boardId: string): string {
			const json = changesJson(of(boardId).get())
			save(boardId, { since: now(), entries: [] })
			return json
		},
	}
}

// ---- Update suggestions

export const UPDATE_PROMPT = 'Update suggestions'

/** The prompt, with the changes as the tldraw://<boardId>/changes resource. */
export function updateRequest(boardId: string, json: string): AskRequest {
	return { text: UPDATE_PROMPT, resources: [{ uri: `tldraw://${boardId}/changes`, mimeType: 'application/json', text: json }] }
}

type Store = ReturnType<typeof createChanges>

/**
 * Update suggestions: asks the agent with this viewer's changes and clears them; once that turn
 * ends with end_turn, `caughtUp` gets its key. Returns how many changes went.
 */
export function createUpdater(
	store: Pick<Store, 'get' | 'take'>,
	bus: { ask(request: AskRequest): void },
	turns: { onEnded(listener: (end: TurnEnd) => void): () => void }
) {
	// one waiting caller per Update suggestions sent, in order
	const waiting: ((end: TurnEnd) => void)[] = []
	let listening = false
	return (boardId: string, caughtUp: (turnKey: string) => void): number => {
		const count = store.get(boardId).entries.length
		if (!count) return 0
		if (!listening) {
			listening = true
			turns.onEnded((end) => end.prompt === UPDATE_PROMPT && waiting.shift()?.(end))
		}
		waiting.push((end) => end.stopReason === 'end_turn' && caughtUp(end.key))
		bus.ask(updateRequest(boardId, store.take(boardId)))
		return count
	}
}

function sessionStore(): StorageLike | null {
	try {
		return typeof sessionStorage === 'undefined' ? null : sessionStorage
	} catch {
		return null
	}
}

export const changes = createChanges(sessionStore())

export const updateSuggestions = createUpdater(changes, chatBus, chatTurns)

// ---- edits made through an editor go to its board's changes (sideEffects.ts ties them)

const boards = new WeakMap<object, string>()

export function watchBoard(editor: object, boardId: string): () => void {
	boards.set(editor, boardId)
	return () => {
		if (boards.get(editor) === boardId) boards.delete(editor)
	}
}

/** The board an editor's edits are recorded for, if any. */
export const boardOf = (editor: object) => boards.get(editor) ?? null

export function recordEdit(editor: object, change: Change, shapeId?: string): () => void {
	const boardId = boards.get(editor)
	return boardId ? changes.record(boardId, change, shapeId) : () => {}
}
