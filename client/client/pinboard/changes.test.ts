import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTurnBus, endedTurns, type AskRequest } from '../chat/chatBus.ts'
import { fakeEditor } from '../editing/fixtures/fakeEditor.ts'
import { registerBoardSideEffects } from '../sideEffects.ts'
import { castVote } from '../widgets/votes.ts'
import {
	addChange,
	changes,
	changesJson,
	createChanges,
	createUpdater,
	describeChange,
	linkShapeBack,
	linkShapeGone,
	noteDeleted,
	noteText,
	noteUnpinned,
	shapeEdit,
	UPDATE_PROMPT,
	updateRequest,
	type Change,
	type Entry,
	type StorageLike,
} from './changes.ts'

const T0 = '2026-10-21T09:00:00.000Z'
const at = (n: number) => `2026-10-21T09:0${n}:00.000Z`

function run(...changes: Change[]): Entry[] {
	return changes.reduce<Entry[]>((entries, change, i) => addChange(entries, change, at(i + 1)), [])
}
const types = (entries: Entry[]) => entries.map((e) => e.change.type)

const liuCites = { from: 'pmid:2', to: 'pmid:1', kind: 'cites' } as const
const mine = { from: 'pmid:2', to: 'pmid:3', kind: 'user' } as const

test('moving a paper three times is one change; another paper is another', () => {
	const entries = run(
		{ type: 'moved', paperId: 'pmid:1' },
		{ type: 'moved', paperId: 'pmid:1' },
		{ type: 'moved', paperId: 'pmid:2' },
		{ type: 'moved', paperId: 'pmid:1' }
	)
	assert.deepEqual(
		entries.map((e) => [e.change, e.at]),
		[
			[{ type: 'moved', paperId: 'pmid:1' }, at(1)],
			[{ type: 'moved', paperId: 'pmid:2' }, at(3)],
		]
	)
})

test('the latest vote and the latest name win', () => {
	const entries = run(
		{ type: 'voted', paperId: 'pmid:1', decision: 'keep' },
		{ type: 'voted', paperId: 'pmid:1', decision: 'discard' },
		{ type: 'link_renamed', ...liuCites, label: 'same cohort' },
		{ type: 'link_renamed', ...liuCites, label: 'compare with' },
		{ type: 'cluster_renamed', clusterId: 'c1', label: 'Tumour' },
		{ type: 'cluster_renamed', clusterId: 'c1', label: 'Tumour ecosystem' }
	)
	assert.deepEqual(
		entries.map((e) => e.change),
		[
			{ type: 'voted', paperId: 'pmid:1', decision: 'discard' },
			{ type: 'link_renamed', ...liuCites, label: 'compare with' },
			{ type: 'cluster_renamed', clusterId: 'c1', label: 'Tumour ecosystem' },
		]
	)
})

test('a link you draw and name is one change; drawn and deleted, none', () => {
	const named = run({ type: 'link_added', ...mine }, { type: 'link_renamed', ...mine, label: 'same method' })
	assert.deepEqual(
		named.map((e) => e.change),
		[{ type: 'link_added', ...mine, label: 'same method' }]
	)
	assert.deepEqual(run({ type: 'link_added', ...mine }, { type: 'link_renamed', ...mine, label: 'x' }, { type: 'link_removed', ...mine }), [])
	// the agent's link, named then deleted: only the delete is left
	const similar = { from: 'pmid:4', to: 'pmid:1', kind: 'similar' } as const
	assert.deepEqual(types(run({ type: 'link_renamed', ...similar, label: 'x' }, { type: 'link_hidden', ...similar }, { type: 'link_removed', ...similar })), [
		'link_removed',
	])
	// hiding and naming a citation are two changes
	assert.deepEqual(types(run({ type: 'link_renamed', ...liuCites, label: 'x' }, { type: 'link_hidden', ...liuCites })), [
		'link_renamed',
		'link_hidden',
	])
})

test('a note you add and then pin is one change, which follows its text and its pin', () => {
	let entries = run({ type: 'note_added', noteId: 'shape:n1', text: '' }, { type: 'note_pinned', noteId: 'shape:n1', text: '', paperId: 'pmid:1' })
	assert.deepEqual(
		entries.map((e) => e.change),
		[{ type: 'note_added', noteId: 'shape:n1', text: '', paperId: 'pmid:1' }]
	)
	entries = noteText(entries, 'shape:n1', 'Ask Igor about the cohort')
	assert.equal((entries[0].change as { text: string }).text, 'Ask Igor about the cohort')
	assert.equal(noteText(entries, 'shape:n1', 'Ask Igor about the cohort'), entries) // nothing new: the same list
	assert.equal(noteText(entries, 'shape:other', 'x'), entries) // editing an older note isn't a change
	entries = noteUnpinned(entries, 'shape:n1', 'Ask Igor about the cohort', 'pmid:1', at(3))
	assert.deepEqual(entries[0].change, { type: 'note_added', noteId: 'shape:n1', text: 'Ask Igor about the cohort' })
	assert.deepEqual(noteDeleted(entries, 'shape:n1', 'Ask Igor about the cohort', undefined, at(4)), [])

	// an older note pinned now, then dragged off again: nothing
	const pinned = run({ type: 'note_pinned', noteId: 'shape:old', text: 'Grant needs this', paperId: 'pmid:2' })
	assert.deepEqual(noteUnpinned(pinned, 'shape:old', 'Grant needs this', 'pmid:2', at(2)), [])
})

test('a note from before this session, unpinned or deleted, is a change of its own', () => {
	const moved = run({ type: 'moved', paperId: 'pmid:1' })
	assert.deepEqual(noteUnpinned(moved, 'shape:old', 'Grant needs this', 'pmid:2', at(2)).slice(1), [
		{ key: 'note shape:old', change: { type: 'note_unpinned', noteId: 'shape:old', text: 'Grant needs this', paperId: 'pmid:2' }, at: at(2) },
	])
	assert.deepEqual(noteDeleted(moved, 'shape:old', 'Same patients?', 'pmid:2', at(2)).slice(1), [
		{ key: 'note shape:old', change: { type: 'note_removed', noteId: 'shape:old', text: 'Same patients?', paperId: 'pmid:2' }, at: at(2) },
	])
	// a free note deleted has no paper
	assert.deepEqual(noteDeleted([], 'shape:free', 'Ask Igor', undefined, at(1))[0].change, {
		type: 'note_removed',
		noteId: 'shape:free',
		text: 'Ask Igor',
	})
	// the agent gets them without the note's shape ID, as note_added
	const entries = [...noteUnpinned([], 'shape:a', 'x', 'pmid:2', at(1)), ...noteDeleted([], 'shape:b', 'y', undefined, at(2))]
	assert.deepEqual(JSON.parse(changesJson({ since: T0, entries })).changes, [
		{ type: 'note_unpinned', text: 'x', paperId: 'pmid:2', at: at(1) },
		{ type: 'note_removed', text: 'y', at: at(2) },
	])
})

test('the JSON is {since, changes: [{…, at}]}, the <board-changes> contract', () => {
	const entries = run(
		{ type: 'moved', paperId: 'pmid:1' },
		{ type: 'note_pinned', noteId: 'shape:n1', text: 'Same patients?', paperId: 'pmid:2' },
		{ type: 'voted', paperId: 'pmid:3', decision: 'keep' },
		{ type: 'link_hidden', ...liuCites }
	)
	assert.deepEqual(JSON.parse(changesJson({ since: T0, entries })), {
		since: T0,
		changes: [
			{ type: 'moved', paperId: 'pmid:1', at: at(1) },
			{ type: 'note_pinned', text: 'Same patients?', paperId: 'pmid:2', at: at(2) },
			{ type: 'voted', paperId: 'pmid:3', decision: 'keep', at: at(3) },
			{ type: 'link_hidden', from: 'pmid:2', to: 'pmid:1', kind: 'cites', at: at(4) },
		],
	})
})

test('a link change keeps its arrow’s shape ID in the browser; the JSON leaves it out', () => {
	const entries = addChange([], { type: 'link_removed', ...liuCites }, at(1), 'shape:link-x')
	assert.equal(entries[0].shapeId, 'shape:link-x')
	const json = changesJson({ since: T0, entries })
	assert.deepEqual(JSON.parse(json).changes, [{ type: 'link_removed', from: 'pmid:2', to: 'pmid:1', kind: 'cites', at: at(1) }])
	assert.ok(!json.includes('shape:link-x'))
	// naming a link you drew keeps the drawing's shape ID
	const named = addChange(addChange([], { type: 'link_added', ...mine }, at(1), 'shape:link-y'), { type: 'link_renamed', ...mine, label: 'x' }, at(2), 'shape:link-y')
	assert.deepEqual(named.map((e) => [e.change.type, e.shapeId]), [['link_added', 'shape:link-y']])
})

test('an arrow back on the board takes back its deletion or hiding; one gone takes back its drawing', () => {
	const removed = addChange([], { type: 'link_removed', ...liuCites }, at(1), 'shape:link-x')
	assert.deepEqual(linkShapeBack(removed, 'shape:link-x'), [])
	assert.equal(linkShapeBack(removed, 'shape:other'), removed) // nothing to drop: the same list
	assert.equal(linkShapeGone(removed, 'shape:link-x'), removed)
	const hidden = addChange([], { type: 'link_hidden', ...liuCites }, at(1), 'shape:link-x')
	assert.deepEqual(linkShapeBack(hidden, 'shape:link-x'), [])
	const drawn = run({ type: 'moved', paperId: 'pmid:1' })
	const withLink = addChange(drawn, { type: 'link_added', ...mine }, at(2), 'shape:link-y')
	assert.deepEqual(linkShapeGone(withLink, 'shape:link-y'), drawn)
	assert.equal(linkShapeBack(withLink, 'shape:link-y'), withLink)
	// an entry recorded without a shape ID is never matched
	const old = run({ type: 'link_removed', ...liuCites })
	assert.equal(linkShapeBack(old, 'shape:link-x'), old)
})

test('⌘Z and ⇧⌘Z on a link keep the changes list in step with the board', () => {
	const paper = (id: string, paperId: string) => ({ id, type: 'paper-card', props: { paperId }, meta: {} })
	const similar = { id: 'shape:link-s', type: 'arrow', props: {}, meta: { kind: 'similar', label: '', hiddenByHuman: false } }
	const { editor, fake, shapes } = fakeEditor([paper('shape:paper-a', 'pmid:2'), paper('shape:paper-b', 'pmid:1'), similar])
	const off = registerBoardSideEffects(editor, 'm_me', 'b_undo')
	const now = () => changes.get('b_undo').entries.map((e) => e.change.type)
	try {
		// hidden, then ⌘Z shows it again
		changes.record('b_undo', { type: 'link_hidden', ...liuCites }, similar.id)
		fake.updateShape({ id: similar.id, meta: { hiddenByHuman: true } })
		assert.deepEqual(now(), ['link_hidden'])
		fake.updateShape({ id: similar.id, meta: { hiddenByHuman: false } })
		assert.deepEqual(now(), [])

		// deleted (recorded before the delete, as the link editor does), then ⌘Z brings it back
		changes.record('b_undo', { type: 'link_removed', ...liuCites }, similar.id)
		fake.deleteShapes([similar.id])
		assert.deepEqual(now(), ['link_removed'])
		fake.createShape(similar)
		assert.deepEqual(now(), [])

		// drawn with the + handle, then ⌘Z takes it away
		fake.createShape({ id: 'shape:link-mine', type: 'arrow' })
		changes.record('b_undo', { type: 'link_added', ...mine }, 'shape:link-mine')
		assert.equal(shapes.get('shape:link-mine')!.meta.kind, 'user')
		fake.deleteShapes(['shape:link-mine'])
		assert.deepEqual(now(), [])

		// a link drawn and deleted in this session is nothing, before and after the delete runs
		fake.createShape({ id: 'shape:link-mine', type: 'arrow' })
		changes.record('b_undo', { type: 'link_added', ...mine }, 'shape:link-mine')
		changes.record('b_undo', { type: 'link_removed', ...mine }, 'shape:link-mine')
		fake.deleteShapes(['shape:link-mine'])
		assert.deepEqual(now(), [])
	} finally {
		off()
	}
})

test('deleting a note from before this session tells the agent its text and the paper it was pinned to', () => {
	const text = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Same patients?' }] }] }
	const { editor, fake, bindings } = fakeEditor([
		{ id: 'shape:paper-a', type: 'paper-card', props: { paperId: 'pmid:2' } },
		{ id: 'shape:note-old', type: 'note', props: { richText: text } },
	])
	bindings.set('binding:pin', { id: 'binding:pin', type: 'note-pin', fromId: 'shape:note-old', toId: 'shape:paper-a', props: {}, meta: {} })
	const off = registerBoardSideEffects(editor, 'm_me', 'b_note')
	try {
		fake.deleteShapes(['shape:note-old'])
		assert.deepEqual(
			changes.get('b_note').entries.map((e) => e.change),
			[{ type: 'note_removed', noteId: 'shape:note-old', text: 'Same patients?', paperId: 'pmid:2' }]
		)
	} finally {
		off()
	}
})

test('each change in plain words', () => {
	const labels: Record<string, string> = { 'pmid:1': 'Daugherty-Lopès 2024', 'pmid:2': 'Ibáñez-Molero 2026', 'pmid:3': 'Liu 2022' }
	const say = (change: Change) => describeChange(change, (id) => labels[id] ?? id)
	assert.equal(say({ type: 'moved', paperId: 'pmid:1' }), 'You moved Daugherty-Lopès 2024')
	assert.equal(say({ type: 'note_pinned', noteId: 'n', text: '', paperId: 'pmid:2' }), 'You pinned a note to Ibáñez-Molero 2026')
	assert.equal(say({ type: 'note_added', noteId: 'n', text: '', paperId: 'pmid:3' }), 'You added a note on Liu 2022')
	assert.equal(say({ type: 'note_added', noteId: 'n', text: '' }), 'You added a note')
	assert.equal(say({ type: 'note_unpinned', noteId: 'n', text: '', paperId: 'pmid:2' }), 'You unpinned a note from Ibáñez-Molero 2026')
	assert.equal(say({ type: 'note_removed', noteId: 'n', text: 'Same patients?' }), 'You deleted a note: “Same patients?”')
	assert.equal(say({ type: 'link_added', ...mine }), 'You linked Ibáñez-Molero 2026 and Liu 2022')
	assert.equal(say({ type: 'link_added', ...mine, label: 'same method' }), 'You linked Ibáñez-Molero 2026 and Liu 2022 as “same method”')
	assert.equal(say({ type: 'link_renamed', ...mine, label: 'x' }), 'You named the link Ibáñez-Molero 2026 – Liu 2022 “x”')
	assert.equal(say({ type: 'link_renamed', ...mine, label: '' }), 'You took the name off the link Ibáñez-Molero 2026 – Liu 2022')
	assert.equal(say({ type: 'link_hidden', ...liuCites }), 'You hid the link Ibáñez-Molero 2026 – Daugherty-Lopès 2024')
	assert.equal(say({ type: 'link_removed', ...mine }), 'You deleted the link Ibáñez-Molero 2026 – Liu 2022')
	assert.equal(say({ type: 'voted', paperId: 'pmid:3', decision: 'keep' }), 'You kept Liu 2022')
	assert.equal(say({ type: 'voted', paperId: 'pmid:3', decision: 'discard' }), 'You discarded Liu 2022')
	assert.equal(say({ type: 'voted', paperId: 'pmid:3', decision: null }), 'You took back your vote on Liu 2022')
	assert.equal(say({ type: 'cluster_renamed', clusterId: 'c1', label: 'Tumour ecosystem' }), 'You renamed a cluster “Tumour ecosystem”')
})

test('which of a person’s shape changes count: a paper moved, a cluster renamed', () => {
	const card = { type: 'paper-card', x: 0, y: 0, parentId: 'page:page', props: { paperId: 'pmid:1', status: 'new' }, meta: {} }
	assert.deepEqual(shapeEdit(card, { ...card, x: 40 }), { type: 'moved', paperId: 'pmid:1' })
	assert.deepEqual(shapeEdit(card, { ...card, parentId: 'shape:cluster-c1' }), { type: 'moved', paperId: 'pmid:1' })
	// a vote or the agent's scores change props, not the place
	assert.equal(shapeEdit(card, { ...card, props: { paperId: 'pmid:1', status: 'kept' } }), null)

	const frame = { type: 'frame', x: 0, y: 0, parentId: 'page:page', props: { name: 'Tumour', w: 300, h: 200 }, meta: { clusterId: 'c1' } }
	assert.deepEqual(shapeEdit(frame, { ...frame, props: { ...frame.props, name: 'Tumour ecosystem' } }), {
		type: 'cluster_renamed',
		clusterId: 'c1',
		label: 'Tumour ecosystem',
	})
	assert.equal(shapeEdit(frame, { ...frame, x: 50 }), null)
	// a frame that isn't a cluster, and a note, don't count
	assert.equal(shapeEdit({ ...frame, meta: {} }, { ...frame, meta: {}, props: { ...frame.props, name: 'x' } }), null)
	const note = { type: 'note', x: 0, y: 0, parentId: 'page:page', props: {}, meta: {} }
	assert.equal(shapeEdit(note, { ...note, x: 5 }), null)
})

function memoryStorage(): StorageLike & { items: Map<string, string> } {
	const items = new Map<string, string>()
	return { items, getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v) }
}

test('changes are kept per board in session storage and survive a reload', () => {
	const storage = memoryStorage()
	let clock = 0
	const now = () => at(clock++)
	const first = createChanges(storage, now)
	first.record('b_1', { type: 'moved', paperId: 'pmid:1' })
	first.record('b_2', { type: 'moved', paperId: 'pmid:9' })
	assert.deepEqual([...storage.items.keys()], ['pinboard-changes:b_1', 'pinboard-changes:b_2'])

	const reloaded = createChanges(storage, now)
	assert.deepEqual(reloaded.get('b_1'), { since: at(0), entries: [{ key: 'moved pmid:1', change: { type: 'moved', paperId: 'pmid:1' }, at: at(1) }] })
	assert.equal(reloaded.get('b_2').entries.length, 1)
})

test('Update suggestions takes the JSON and starts over; Undo puts a thing’s changes back', () => {
	const storage = memoryStorage()
	let clock = 0
	const store = createChanges(storage, () => at(clock++))
	store.record('b_1', { type: 'moved', paperId: 'pmid:1' })
	const undo = store.record('b_1', { type: 'link_hidden', ...liuCites })
	assert.equal(store.get('b_1').entries.length, 2)
	undo()
	assert.deepEqual(types(store.get('b_1').entries), ['moved'])

	// a link drawn this session, deleted, then the delete undone: drawn again
	store.record('b_1', { type: 'link_added', ...mine })
	const undoDelete = store.record('b_1', { type: 'link_removed', ...mine })
	assert.deepEqual(types(store.get('b_1').entries), ['moved'])
	undoDelete()
	assert.deepEqual(types(store.get('b_1').entries), ['moved', 'link_added'])

	const json = JSON.parse(store.take('b_1'))
	assert.equal(json.since, at(0))
	assert.deepEqual(json.changes.map((c: { type: string }) => c.type), ['moved', 'link_added'])
	assert.equal(store.get('b_1').entries.length, 0)
	assert.equal(store.get('b_1').since, at(clock - 1))
	assert.deepEqual(JSON.parse(storage.items.get('pinboard-changes:b_1')!).entries, [])
})

test('without storage the changes live in memory', () => {
	const store = createChanges(null, () => T0)
	store.record('b_1', { type: 'moved', paperId: 'pmid:1' })
	assert.equal(store.get('b_1').entries.length, 1)
})

test('a saved vote counts as a change; one the board service refuses doesn’t', async (t) => {
	let status = 200
	t.mock.method(globalThis, 'fetch', async () =>
		status === 200
			? new Response(JSON.stringify({ status: 'kept', keepBy: ['m_me'], discardBy: [] }), { status })
			: new Response(JSON.stringify({ error: { code: 'not_found', message: 'No card' } }), { status })
	)
	await castVote('b_votes', { paperId: 'pmid:1', keepBy: [], discardBy: [] }, 'm_me', 'keep')
	assert.deepEqual(
		changes.get('b_votes').entries.map((e) => e.change),
		[{ type: 'voted', paperId: 'pmid:1', decision: 'keep' }]
	)
	status = 404
	await assert.rejects(castVote('b_votes', { paperId: 'pmid:2', keepBy: [], discardBy: [] }, 'm_me', 'discard'))
	assert.equal(changes.get('b_votes').entries.length, 1)
})

test('Update suggestions sends one prompt carrying every change, as the changes resource, and resets the counter', () => {
	let clock = 0
	const store = createChanges(null, () => at(clock++))
	const asked: AskRequest[] = []
	const turns = createTurnBus()
	const update = createUpdater(store, { ask: (r) => asked.push(r) }, turns)
	assert.equal(update('b_1', () => {}), 0) // nothing to send
	assert.equal(asked.length, 0)

	store.record('b_1', { type: 'moved', paperId: 'pmid:1' })
	store.record('b_1', { type: 'note_added', noteId: 'shape:n1', text: 'Same cohort?', paperId: 'pmid:2' })
	assert.equal(update('b_1', () => {}), 2)
	assert.equal(store.get('b_1').entries.length, 0)
	const [request] = asked
	assert.equal(request.text, 'Update suggestions')
	assert.deepEqual(
		request.resources?.map(({ uri, mimeType }) => [uri, mimeType]),
		[['tldraw://b_1/changes', 'application/json']]
	)
	const sent = JSON.parse(request.resources![0].text)
	assert.equal(sent.since, at(0))
	assert.deepEqual(sent.changes.map((c: { type: string }) => c.type), ['moved', 'note_added'])
	assert.deepEqual(updateRequest('b_1', '{}'), { text: UPDATE_PROMPT, resources: [{ uri: 'tldraw://b_1/changes', mimeType: 'application/json', text: '{}' }] })
})

test('when that turn ends with end_turn the caller hears its key; other turns, or a cancelled one, don’t count', () => {
	const store = createChanges(null, () => T0)
	const turns = createTurnBus()
	const update = createUpdater(store, { ask: () => {} }, turns)
	const caughtUp: string[] = []

	store.record('b_1', { type: 'moved', paperId: 'pmid:1' })
	update('b_1', (key) => caughtUp.push(key))
	turns.ended({ key: 't3', prompt: 'Why is Liu 2022 first?', stopReason: 'end_turn' })
	assert.equal(caughtUp.length, 0)
	turns.ended({ key: 't4', prompt: 'Update suggestions', stopReason: 'end_turn' })
	assert.deepEqual(caughtUp, ['t4'])
	// heard once
	turns.ended({ key: 't5', prompt: 'Update suggestions', stopReason: 'end_turn' })
	assert.deepEqual(caughtUp, ['t4'])

	store.record('b_1', { type: 'moved', paperId: 'pmid:2' })
	update('b_1', (key) => caughtUp.push(key))
	turns.ended({ key: 't6', prompt: 'Update suggestions', stopReason: 'cancelled' })
	assert.deepEqual(caughtUp, ['t4'])
})

test('the chat reports the turns that stopped running, and opens at a turn on request', () => {
	const before = [
		{ key: 't1', prompt: 'Start this board.', running: false, stopReason: 'end_turn' },
		{ key: 't2', prompt: 'Update suggestions', running: true, stopReason: null },
	]
	const after = [before[0], { ...before[1], running: false, stopReason: 'end_turn' }]
	assert.deepEqual(endedTurns(before, after), [{ key: 't2', prompt: 'Update suggestions', stopReason: 'end_turn' }])
	assert.deepEqual(endedTurns(after, after), [])
	// a turn that errored stops too, with no stop reason
	assert.deepEqual(endedTurns(before, [before[0], { ...before[1], running: false }]), [
		{ key: 't2', prompt: 'Update suggestions', stopReason: null },
	])

	const turns = createTurnBus()
	const shown: string[] = []
	const off = turns.onShow((key) => shown.push(key))
	turns.show('t2')
	off()
	turns.show('t3')
	assert.deepEqual(shown, ['t2'])
})
