import { Box, type Editor, type TLShape, type TLShapeId } from 'tldraw'
import { paperShapeId } from '../../shared/ids.ts'
import { PAPER_CARD_TYPE } from '../../shared/paperCard.ts'
import { currentGoal, litPaperIds, openPaperId } from '../viewerState'
import { runTour, stepsOnBoard, visibleCard } from '../widgets/tour.ts'
import { viewerBus } from './viewerBus.ts'

// The browser half of T06's actions: carry out viewerBus events on this viewer's canvas only. The
// camera, lit papers, the open paper and the tour are local state, never written to the room.
// The busy-user queue and "Follow the agent" are still to come.

const DEFAULT_HIGHLIGHT_MS = 4000

export function registerViewerActions(editor: Editor) {
	let highlightTimer: ReturnType<typeof setTimeout> | undefined

	// paper IDs become their card's shape ID; only shapes on the current page count
	const resolve = ({ shapeIds, paperIds }: { shapeIds?: string[] | null; paperIds?: string[] | null }) => {
		const pageId = editor.getCurrentPageId()
		const ids = [...(shapeIds ?? []), ...(paperIds ?? []).map(paperShapeId)] as TLShapeId[]
		return ids
			.map((id) => editor.getShape(id))
			.filter((s): s is TLShape => !!s && editor.getAncestorPageId(s) === pageId)
	}

	const offs = [
		viewerBus.on('focus', (params) => {
			const bounds = resolve(params).flatMap((s) => editor.getShapePageBounds(s) ?? [])
			if (!bounds.length) return viewerBus.emit('notice', { text: "That paper isn't on the board yet." })
			editor.zoomToBounds(Box.Common(bounds), {
				inset: params.inset ?? 96,
				// one small card shouldn't fill the screen
				targetZoom: 1,
				animation: params.animate === false ? undefined : { duration: 450 },
			})
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
		viewerBus.on('open_paper', ({ paperId }) => openPaperId.set(paperId)),
		// the agent's Catch me up runs like the top bar's, with its own lines; papers not on the board are left out
		viewerBus.on('tour', ({ title, steps }) => {
			const onBoard = stepsOnBoard(steps, currentGoal.get(), (paperId) => visibleCard(editor, paperId))
			if (!onBoard.length) return viewerBus.emit('notice', { text: "Those papers aren't on the board yet." })
			runTour({ type: 'start', steps: onBoard, title })
		}),
	]

	return () => {
		offs.forEach((off) => off())
		clearTimeout(highlightTimer)
	}
}
