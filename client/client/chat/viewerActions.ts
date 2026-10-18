import { Box, type Editor, type TLShape, type TLShapeId } from 'tldraw'
import { paperShapeId } from '../../shared/ids.ts'
import { PAPER_CARD_TYPE } from '../../shared/paperCard.ts'
import { litPaperIds, openPaperId } from '../viewerState'
import { viewerBus } from './viewerBus.ts'

// The browser half of T06's simplest actions: carry out viewerBus events on this viewer's canvas
// only. The camera, lit papers and the open paper are local state, never written to the room.
// T06 adds the busy-user queue, "Follow the agent" and the tour.

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
		viewerBus.on('tour', (params) => console.info('[chat] _canvas/tour arrived; the tour is not built yet (T06, T10)', params)),
	]

	return () => {
		offs.forEach((off) => off())
		clearTimeout(highlightTimer)
	}
}
