import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { Editor, TLShape, TLShapeId } from 'tldraw'
import type { SnapshotResult } from '../../shared/acpExt.ts'
import { NOTE_PIN_TYPE } from '../../shared/bindings.ts'
import { paperShapeId } from '../../shared/ids.ts'
import { PAPER_CARD_TYPE } from '../../shared/paperCard.ts'
import type { PaperCardShape } from '../../shared/shapes.ts'
import { currentGoal, openPaperId } from '../viewerState.ts'
import { takeSnapshot, type SnapshotRequest } from './snapshot.ts'

// What the researcher is looking at, added to what they typed when they press Send (T07; group
// README, Shared contracts, "Prompt content"): the text first, then the selected shapes and the
// open paper as compact JSON, a summary of the view, the request's own resources and, with
// "Include my view" on, a picture of the view after a line saying what it is. The harness turns
// the resources into <selected-shape> and <viewport> tags (harness/acp/mapping.py).

export const SHAPE_MIME = 'application/vnd.tldraw.shape+json'
export const MAX_SHAPES = 20
const MAX_VISIBLE_PAPERS = 100
const MAX_TEXT = 1000
/** The line before every picture of the board, here and in the harness's images plugin. */
export const PICTURE_LINE = 'Picture of the board: '

/** One shape as the agent reads it (`fit` and `why` for this viewer's goal). */
export interface ContextShape {
	shapeId: string
	type: string
	paperId?: string
	title?: string
	year?: number | null
	status?: string
	fit?: string
	why?: string
	/** The label of the figure on the card, which `look_at_figure` can show the agent. */
	figure?: string
	/** The paper is open on the researcher's screen rather than selected. */
	open?: true
	text?: string
	/** A frame's name, with the papers inside it. */
	label?: string
	paperIds?: string[]
	/** A link's papers and kind. */
	from?: string | null
	to?: string | null
	kind?: string
	pinnedTo?: string | null
	author?: string
	createdBy?: string
}

const isCard = (s: TLShape | undefined): s is PaperCardShape => s?.type === PAPER_CARD_TYPE
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

export function toContextShape(editor: Editor, shape: TLShape, goal: string): ContextShape {
	const out: ContextShape = { shapeId: shape.id, type: shape.type }
	const paperOf = (id: string) => {
		const s = editor.getShape(id as TLShapeId)
		return isCard(s) ? s.props.paperId : null
	}
	if (isCard(shape)) {
		const { paperId, title, year, status, scores, figure } = shape.props
		Object.assign(out, { paperId, title, year, status })
		const score = scores[goal]
		if (score) out.fit = score.fit
		if (score?.why) out.why = score.why
		if (figure) out.figure = figure.label || 'Figure'
	} else if (shape.type === 'frame') {
		out.label = (shape.props as { name: string }).name
		out.paperIds = editor.getSortedChildIdsForParent(shape.id).flatMap((id) => paperOf(id) ?? [])
	} else {
		const text = editor.getShapeUtil(shape).getText(shape)?.trim()
		if (text) out.text = text.slice(0, MAX_TEXT)
		if (shape.type === 'note') {
			const pin = editor.getBindingsFromShape(shape, NOTE_PIN_TYPE)[0]
			out.pinnedTo = pin ? paperOf(pin.toId) : null
		}
		if (shape.type === 'arrow') {
			const ends = editor.getBindingsFromShape(shape, 'arrow')
			const end = (terminal: string) => {
				const b = ends.find((e) => (e.props as { terminal?: string }).terminal === terminal)
				return b ? paperOf(b.toId) : null
			}
			Object.assign(out, { from: end('start'), to: end('end'), kind: str(shape.meta.kind) ?? 'user' })
		}
	}
	const author = str(shape.meta.author)
	const createdBy = str(shape.meta.createdBy)
	if (author) out.author = author
	else if (createdBy) out.createdBy = createdBy
	return out
}

/** `{visiblePaperIds, visibleNoteCount, zoom}` for the `tldraw://<boardId>/viewport` resource. */
export function viewportSummary(editor: Editor) {
	const view = editor.getViewportPageBounds()
	const visible = editor
		.getCurrentPageShapes()
		.filter((s) => !editor.isShapeHidden(s) && editor.getShapePageBounds(s)?.collides(view))
	return {
		visiblePaperIds: visible.filter(isCard).map((s) => s.props.paperId).slice(0, MAX_VISIBLE_PAPERS),
		visibleNoteCount: visible.filter((s) => s.type === 'note').length,
		zoom: Math.round(editor.getZoomLevel() * 100) / 100,
		...(openPaperId.get() ? { openPaperId: openPaperId.get() } : {}),
	}
}

const resource = (uri: string, mimeType: string, text: string): ContentBlock => ({ type: 'resource', resource: { uri, mimeType, text } })

/** The selection (the first 20), the open paper when it isn't selected, and the view summary. */
export function contextResources(editor: Editor, boardId: string): ContentBlock[] {
	const goal = currentGoal.get()
	const selected = editor.getSelectedShapes()
	const blocks = selected
		.slice(0, MAX_SHAPES)
		.map((s) => resource(`tldraw://${boardId}/${s.id}`, SHAPE_MIME, JSON.stringify(toContextShape(editor, s, goal))))
	if (selected.length > MAX_SHAPES) {
		blocks.push({ type: 'text', text: `And ${selected.length - MAX_SHAPES} more selected shapes, not listed.` })
	}
	const open = openPaperId.get()
	const card = open ? editor.getShape(paperShapeId(open) as TLShapeId) : undefined
	if (card && !selected.some((s) => s.id === card.id)) {
		const shape = { ...toContextShape(editor, card, goal), open: true as const }
		blocks.push(resource(`tldraw://${boardId}/${card.id}`, SHAPE_MIME, JSON.stringify(shape)))
	}
	blocks.push(resource(`tldraw://${boardId}/viewport`, 'application/json', JSON.stringify(viewportSummary(editor))))
	return blocks
}

/** The picture of the view after the line saying what it is; nothing if it can't be drawn (an empty board). */
export async function viewPicture(
	take: (request: SnapshotRequest) => Promise<SnapshotResult> = takeSnapshot
): Promise<ContentBlock[]> {
	try {
		const shot = await take({ target: 'viewport' })
		return [
			{ type: 'text', text: PICTURE_LINE + shot.caption },
			{ type: 'image', mimeType: shot.mimeType, data: shot.data },
		]
	} catch (e) {
		console.info('[chat] no picture of the view:', e instanceof Error ? e.message : e)
		return []
	}
}

/** The prompt in the contract's order: text, context resources, the request's resources, then pictures. */
export function withContext(blocks: ContentBlock[], resources: ContentBlock[], pictures: ContentBlock[]): ContentBlock[] {
	const [text, ...rest] = blocks
	return [text, ...resources, ...rest, ...pictures]
}

export interface ContextOptions {
	/** "Include my view": a picture of the view goes with the prompt. */
	includeView: boolean
	take?: (request: SnapshotRequest) => Promise<SnapshotResult>
}

/** `blocks` (the text and any resources of the request) with what the researcher is looking at. */
export async function addBoardContext(
	editor: Editor,
	boardId: string,
	blocks: ContentBlock[],
	{ includeView, take }: ContextOptions
): Promise<ContentBlock[]> {
	const resources = contextResources(editor, boardId)
	return withContext(blocks, resources, includeView ? await viewPicture(take) : [])
}
