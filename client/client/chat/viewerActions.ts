import { Box, type Editor, type TLShape, type TLShapeId } from 'tldraw'
import { paperShapeId } from '../../shared/ids.ts'
import { PAPER_CARD_TYPE, isPaperCard } from '../../shared/paperCard.ts'
import { currentGoal, followAgent, litPaperIds, openPaperId } from '../viewerState.ts'
import { runTour, stepsOnBoard, visibleCard } from '../widgets/tour.ts'
import { chipLabel, due, push, registerFollow, type QueuedAction } from './follow.ts'
import { viewerBus, type ViewerAction } from './viewerBus.ts'

// The browser half of T06's actions: carry out viewerBus events on this viewer's canvas only. The
// camera, lit papers, the open paper and the tour are local state, never written to the room.
//
// The Follow-the-agent gate sits in front: an action the agent asked for (from: 'agent') becomes a
// chat chip when Follow is off, and goes through the busy-user queue when it's on — camera moves
// never interrupt a drag or a text edit. highlight is never gated: it doesn't move the camera.

const DEFAULT_HIGHLIGHT_MS = 4000
const FOCUS_EXPIRY_MS = 5000
const IDLE_POLL_MS = 250

export function registerViewerActions(
	editor: Editor,
	follow?: { memberId: string; runIds: () => ReadonlySet<string> }
) {
	let highlightTimer: ReturnType<typeof setTimeout> | undefined

	// paper IDs become their card's shape ID; only shapes on the current page count
	const resolve = ({ shapeIds, paperIds }: { shapeIds?: string[] | null; paperIds?: string[] | null }) => {
		const pageId = editor.getCurrentPageId()
		const ids = [...(shapeIds ?? []), ...(paperIds ?? []).map(paperShapeId)] as TLShapeId[]
		return ids
			.map((id) => editor.getShape(id))
			.filter((s): s is TLShape => !!s && editor.getAncestorPageId(s) === pageId)
	}

	const titleOf = (paperId: string) => {
		const card = editor.getShape(paperShapeId(paperId) as TLShapeId)
		return isPaperCard(card) ? card.props.title : null
	}

	// ---- the busy-user queue ---------------------------------------------------
	// Busy = pointing, dragging, pinching, panning or editing a shape's text — tldraw's input
	// flags, since select.idle isn't reliable under the note/hand tools.
	let queue: QueuedAction<() => void>[] = []
	let idleTimer: ReturnType<typeof setInterval> | undefined
	const busy = () => {
		const i = editor.inputs
		return !!(i.isPointing || i.isDragging || i.isPinching || i.isPanning || editor.getEditingShapeId())
	}
	const flush = () => {
		const { run, rest } = due(queue, Date.now(), !busy())
		queue = rest
		if (!queue.length) {
			clearInterval(idleTimer)
			idleTimer = undefined
		}
		run.forEach((f) => f())
	}
	const enqueue = (run: () => void, expiresAt: number | null) => {
		queue = push(queue, run, Date.now(), expiresAt)
		idleTimer ??= setInterval(flush, IDLE_POLL_MS)
		flush()
	}
	// a drag or edit can start any time; every event is a chance the viewer went idle
	editor.on('event', flush)

	// What the agent asks for, when Follow the agent is on: queued so it can't interrupt the viewer.
	// When it's off, the action becomes a chip the viewer can click instead.
	const agentAction = (action: ViewerAction, run: () => void, expires: boolean) => {
		if (!followAgent.get()) viewerBus.emit('chip', { label: chipLabel(action, titleOf), action })
		else enqueue(run, expires ? Date.now() + FOCUS_EXPIRY_MS : null)
	}

	const offs = [
		viewerBus.on('focus', (params) => {
			const run = () => {
				const bounds = resolve(params).flatMap((s) => editor.getShapePageBounds(s) ?? [])
				if (!bounds.length) return viewerBus.emit('notice', { text: "That paper isn't on the board yet." })
				editor.zoomToBounds(Box.Common(bounds), {
					inset: params.inset ?? 96,
					// one small card shouldn't fill the screen
					targetZoom: 1,
					animation: params.animate === false ? undefined : { duration: 450 },
				})
			}
			if (params.from !== 'agent') return run()
			const { from: _from, ...clean } = params
			return agentAction({ type: 'focus', params: clean }, run, true)
		}),
		viewerBus.on('highlight', (params) => {
			const papers = new Set(params.paperIds ?? [])
			const others: TLShapeId[] = []
			for (const s of resolve(params)) {
				if (s.type === PAPER_CARD_TYPE) papers.add((s.props as { paperId: string }).paperId)
				else others.push(s.id)
			}
			clearTimeout(highlightTimer)
			litPaperIds.set([...papers])
			editor.setHintingShapes(others)
			highlightTimer = setTimeout(() => {
				litPaperIds.set([])
				editor.setHintingShapes([])
			}, params.durationMs ?? DEFAULT_HIGHLIGHT_MS)
		}),
		viewerBus.on('open_paper', ({ paperId, from }) => {
			const run = () => openPaperId.set(paperId)
			return from === 'agent' ? agentAction({ type: 'open_paper', paperId }, run, false) : run()
		}),
		// the agent's Catch me up runs like the top bar's, with its own lines; papers not on the board are left out
		viewerBus.on('tour', ({ title, steps, from }) => {
			const run = () => {
				const onBoard = stepsOnBoard(steps, currentGoal.get(), (paperId) => visibleCard(editor, paperId))
				if (!onBoard.length) return viewerBus.emit('notice', { text: "Those papers aren't on the board yet." })
				runTour({ type: 'start', steps: onBoard, title })
			}
			return from === 'agent' ? agentAction({ type: 'tour', title, steps }, run, false) : run()
		}),
	]
	const offFollow = follow ? registerFollow(editor, { ...follow, enqueue }) : undefined

	return () => {
		offs.forEach((off) => off())
		offFollow?.()
		editor.off('event', flush)
		clearTimeout(highlightTimer)
		clearInterval(idleTimer)
	}
}
