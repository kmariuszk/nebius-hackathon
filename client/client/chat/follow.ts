import { Box, type Editor, type TLShape } from 'tldraw'
import { isPaperCard } from '../../shared/paperCard.ts'
import { openPaperId, tour } from '../viewerState.ts'
import type { ViewerAction } from './viewerBus.ts'

// Follow the agent (T06, extended): the pure pieces — which cards a running turn may pull the
// camera to, when a move is skipped, the busy-user queue, and the chip labels for when Follow is
// off — plus registerFollow, which watches the agent's placements and moves the camera to keep
// them in view. The gate itself lives in viewerActions.ts.

/** A paper card this chat's running turn just placed (remote create, agent's, this member's run). */
export function isFollowedCard(
	shape: TLShape,
	source: string,
	{ memberId, runIds }: { memberId: string; runIds: ReadonlySet<string> }
): boolean {
	return (
		source === 'remote' &&
		isPaperCard(shape) &&
		shape.meta?.createdBy === 'agent' &&
		shape.meta?.onBehalfOf === memberId &&
		typeof shape.meta?.runId === 'string' &&
		runIds.has(shape.meta.runId as string)
	)
}

export interface MoveConditions {
	/** Every card the run placed is already inside the viewport. */
	allInView: boolean
	/** A paper's widgets are open. */
	paperOpen: boolean
	/** A Catch-me-up tour is running. */
	touring: boolean
	/** The last canvas input (wheel, pinch, pointer down) the viewer gave, epoch ms. */
	lastInputAt: number
	now: number
}

/** Whether a follow move may run; every skip rule from the design. */
export function shouldMove({ allInView, paperOpen, touring, lastInputAt, now }: MoveConditions): boolean {
	return !(allInView || paperOpen || touring || now - lastInputAt < 3000)
}

// ---- the busy-user queue -------------------------------------------------

export interface QueuedAction<T> {
	action: T
	at: number
	/** Focus and follow moves expire after 5 s; open_paper and tour never do. */
	expiresAt: number | null
}

export function push<T>(queue: QueuedAction<T>[], action: T, at: number, expiresAt: number | null): QueuedAction<T>[] {
	return [...queue, { action, at, expiresAt }]
}

/**
 * What to run now: nothing while the viewer is busy; once idle, the unexpired actions in arrival
 * order (the rest is always empty: expired actions are dropped, not kept).
 */
export function due<T>(queue: QueuedAction<T>[], now: number, idle: boolean): { run: T[]; rest: QueuedAction<T>[] } {
	if (!idle) return { run: [], rest: queue }
	return { run: queue.filter((q) => q.expiresAt === null || q.expiresAt > now).map((q) => q.action), rest: [] }
}

/** Set equality: ChatPanel rebuilds the run-ID set on every streamed update, so compare contents. */
export function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	return a.size === b.size && [...a].every((id) => b.has(id))
}

// ---- chips for when Follow is off -----------------------------------------

/** The chip's wording: "Show the paper"/"Show N papers", "Open <title>", "Start the tour (N papers)". */
export function chipLabel(action: ViewerAction, titleOf: (paperId: string) => string | null): string {
	switch (action.type) {
		case 'focus': {
			const n = (action.params.shapeIds?.length ?? 0) + (action.params.paperIds?.length ?? 0)
			return n > 1 ? `Show ${n} papers` : 'Show the paper'
		}
		case 'open_paper': {
			const title = titleOf(action.paperId)
			return title ? `Open ${title}` : 'Open the paper'
		}
		case 'tour':
			return `Start the tour (${action.steps.length} papers)`
	}
}

// ---- following placements --------------------------------------------------

const BATCH_MS = 500
const FOLLOW_EXPIRY_MS = 5000
const INPUT_EVENTS = new Set(['pointer_down', 'wheel', 'pinch_start', 'pinch'])

export interface FollowOptions {
	memberId: string
	/** The running turn's run IDs, kept current by ChatPanel; empty while no turn runs. */
	runIds: () => ReadonlySet<string>
	/** The shared busy queue from viewerActions: follow moves go through it with the 5 s expiry. */
	enqueue: (run: () => void, expiresAt: number | null) => void
}

/**
 * Watches remote creates: cards this chat's running turn places are batched for 500 ms, then one
 * move frames every card placed so far — unless a skip rule from `shouldMove` says not to. Returns
 * the cleanup. Following stops when the turn does because runIds() comes back empty.
 */
export function registerFollow(editor: Editor, { memberId, runIds, enqueue }: FollowOptions): () => void {
	let placed: string[] = []
	let runSet: ReadonlySet<string> = runIds()
	let lastInputAt = 0
	let timer: ReturnType<typeof setTimeout> | undefined

	const move = () => {
		const cards = placed.flatMap((id) => {
			const s = editor.getShape(id as TLShape['id'])
			return s ? [s] : []
		})
		const bounds = cards.flatMap((s) => editor.getShapePageBounds(s) ?? [])
		if (!bounds.length) return
		const view = editor.getViewportPageBounds()
		// strict contains() would count a card that touches the viewport edge as out of view
		const allInView = bounds.every((b) => Box.ContainsApproximately(view, b, 0.01))
		if (
			!shouldMove({
				allInView,
				paperOpen: openPaperId.get() !== null,
				touring: tour.get() !== null,
				lastInputAt,
				now: Date.now(),
			})
		)
			return
		const box = Box.Common(bounds)
		enqueue(
			() =>
				editor.zoomToBounds(box, {
					inset: 96,
					targetZoom: Math.min(1, editor.getZoomLevel()),
					animation: { duration: 450 },
				}),
			Date.now() + FOLLOW_EXPIRY_MS
		)
	}

	const onEvent = (info: { name: string }) => {
		if (INPUT_EVENTS.has(info.name)) lastInputAt = Date.now()
	}
	const offCreate = editor.sideEffects.registerAfterCreateHandler('shape', (shape, source) => {
		const ids = runIds()
		if (!sameIds(ids, runSet)) {
			// a new turn (or none): the cards framed belong to the run that placed them
			runSet = ids
			placed = []
		}
		if (!ids.size || !isFollowedCard(shape, source, { memberId, runIds: ids })) return
		placed.push(shape.id)
		clearTimeout(timer)
		timer = setTimeout(move, BATCH_MS)
	})
	editor.on('event', onEvent)
	return () => {
		offCreate()
		editor.off('event', onEvent)
		clearTimeout(timer)
	}
}
