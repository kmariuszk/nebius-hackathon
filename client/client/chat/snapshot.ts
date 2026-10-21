import { atom, Box, type Editor, type TLShape, type TLShapeId } from 'tldraw'
import type { SnapshotParams, SnapshotResult } from '../../shared/acpExt.ts'
import { NOTE_PIN_TYPE } from '../../shared/bindings.ts'
import { cardLabel } from '../../shared/display.ts'
import { paperShapeId } from '../../shared/ids.ts'
import { isPaperCard } from '../../shared/paperCard.ts'
import { openPaperId } from '../viewerState.ts'

// The pictures the agent sees (T07): one renderer for the agent's `_canvas/snapshot` requests and
// for the view the chat panel attaches to a prompt. tldraw draws this browser's page to a PNG; the
// paper widgets are HTML outside <Tldraw>, so they aren't in it, and the caption names the open
// paper instead. Nothing is drawn in the background: only on a prompt or an agent's request.

export type SnapshotRequest = Omit<SnapshotParams, 'sessionId'>

/** Long side of a snapshot in pixels; about 1,400 prompt tokens on Super VL. */
export const MAX_SIDE = 1600
export const SNAPSHOT_TIMEOUT_MS = 10_000
// a few cards shouldn't be blown up to 1,600 px
const MAX_UPSCALE = 2
const MARGIN = 48

/**
 * Above zero while a snapshot is drawn: getShapeVisibility (shapes/index.ts) then shows the arrows
 * behind the strings, which are drawn in an overlay tldraw can't export, so the picture has the
 * links as lines. A count, since a prompt's view and an agent's request can overlap.
 */
export const exportingSnapshot = atom('exportingSnapshot', 0)

export async function withLinkArrows<T>(draw: () => Promise<T>): Promise<T> {
	exportingSnapshot.update((n) => n + 1)
	try {
		return await draw()
	} finally {
		exportingSnapshot.update((n) => n - 1)
	}
}

/** The export scale that keeps the long side within `maxSide`, and never above 1,600 px. */
export function snapshotScale(width: number, height: number, maxSide?: number | null) {
	const side = Math.min(maxSide ?? MAX_SIDE, MAX_SIDE)
	return Math.min(MAX_UPSCALE, side / Math.max(width, height, 1))
}

export interface SnapshotPlan {
	ids: TLShapeId[]
	bounds: Box
	caption: string
}

/** The shapes shown on the page whose bounds touch the researcher's view. */
export function shapesInView(editor: Editor): TLShape[] {
	const view = editor.getViewportPageBounds()
	return editor.getCurrentPageShapes().filter((s) => !editor.isShapeHidden(s) && editor.getShapePageBounds(s)?.collides(view))
}

/** What a request draws: the shapes, the page area and the caption. Throws with a reason the agent can repeat. */
export function planSnapshot(editor: Editor, request: SnapshotRequest): SnapshotPlan {
	const shown = editor.getCurrentPageShapes().filter((s) => !editor.isShapeHidden(s))
	if (!shown.length) throw new Error('The board is empty.')
	const ids = shown.map((s) => s.id)
	switch (request.target) {
		case 'viewport': {
			const bounds = editor.getViewportPageBounds().clone()
			const inView = shapesInView(editor)
			if (!inView.length) throw new Error("Nothing on the board is in the researcher's view right now.")
			return { ids, bounds, caption: `The researcher's current view, with ${counts(inView)}${openNote(editor)}` }
		}
		case 'board':
			return { ids, bounds: union(editor, shown).expandBy(MARGIN), caption: `Whole board, with ${counts(shown)}` }
		case 'shapes': {
			const onPage = new Map(shown.map((s) => [s.id as string, s]))
			const wanted = [...(request.paperIds ?? []).map(paperShapeId), ...(request.shapeIds ?? [])]
			const named = [...new Set(wanted)].flatMap((id) => onPage.get(id) ?? [])
			if (!named.length) throw new Error("Those papers aren't on the board.")
			const drawn = withNeighbours(editor, named)
			return {
				ids: drawn.map((s) => s.id),
				bounds: union(editor, drawn).expandBy(MARGIN),
				caption: shapesCaption(named, drawn),
			}
		}
	}
}

/** The named shapes plus the links bound to them, the cards at the links' other ends and their pinned notes. */
function withNeighbours(editor: Editor, named: TLShape[]): TLShape[] {
	const found = new Map(named.map((s) => [s.id, s]))
	const add = (id: TLShapeId) => {
		const shape = editor.getShape(id)
		if (shape && !editor.isShapeHidden(shape)) found.set(shape.id, shape)
		return shape
	}
	for (const shape of named) {
		for (const b of editor.getBindingsToShape(shape, 'arrow')) {
			const arrow = add(b.fromId)
			if (arrow) for (const end of editor.getBindingsFromShape(arrow, 'arrow')) add(end.toId)
		}
		for (const end of editor.getBindingsFromShape(shape, 'arrow')) add(end.toId)
		for (const b of editor.getBindingsToShape(shape, NOTE_PIN_TYPE)) add(b.fromId)
	}
	return [...found.values()]
}

function union(editor: Editor, shapes: TLShape[]) {
	return Box.Common(shapes.flatMap((s) => editor.getShapePageBounds(s) ?? []))
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "12 cards, 2 clusters, 3 notes" */
export function counts(shapes: TLShape[]) {
	const cards = shapes.filter(isPaperCard).length
	const clusters = shapes.filter((s) => s.type === 'frame').length
	const notes = shapes.filter((s) => s.type === 'note').length
	const parts = [cards && plural(cards, 'card'), clusters && plural(clusters, 'cluster'), notes && plural(notes, 'note')]
	return parts.filter(Boolean).join(', ') || plural(shapes.length, 'shape')
}

function openNote(editor: Editor) {
	const paperId = openPaperId.get()
	if (!paperId) return ''
	const card = editor.getShape(paperShapeId(paperId) as TLShapeId)
	const name = isPaperCard(card) ? cardLabel(card) : paperId
	return `; ${name} is open, but its panels aren't in the picture`
}

function nameOf(shape: TLShape) {
	if (isPaperCard(shape)) return cardLabel(shape)
	if (shape.type === 'frame') {
		const name = (shape.props as { name?: string }).name
		return name ? `the "${name}" cluster` : 'a cluster'
	}
	return `a ${shape.type === 'geo' ? 'shape' : shape.type}`
}

/** "Liu 2022 and Chen 2023, with 3 linked papers" */
function shapesCaption(named: TLShape[], drawn: TLShape[]) {
	const names = named.map(nameOf)
	const shown = names.length > 6 ? [...names.slice(0, 5), plural(names.length - 5, 'more')] : names
	const list = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0]
	const ids = new Set(named.map((s) => s.id))
	const linked = drawn.filter((s) => isPaperCard(s) && !ids.has(s.id)).length
	return linked ? `${list}, with ${plural(linked, 'linked paper')}` : list
}

/** Base64 without the data: prefix, as `_canvas/snapshot` and ACP image blocks carry it. */
export function toBase64(bytes: Uint8Array) {
	let binary = ''
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
	return btoa(binary)
}

// The export itself; it needs a real browser, so tests fake the renderer instead.
async function drawSnapshot(editor: Editor, request: SnapshotRequest): Promise<SnapshotResult> {
	// planned with the arrows shown, so a `shapes` picture includes the links
	return withLinkArrows(async () => {
		const { ids, bounds, caption } = planSnapshot(editor, request)
		const scale = snapshotScale(bounds.w, bounds.h, request.maxSide)
		const image = await editor.toImage(ids, { format: 'png', bounds, background: true, scale, pixelRatio: 1 })
		return {
			mimeType: 'image/png' as const,
			data: toBase64(new Uint8Array(await image.blob.arrayBuffer())),
			width: Math.round(image.width),
			height: Math.round(image.height),
			caption,
		}
	})
}

type Renderer = (request: SnapshotRequest) => Promise<SnapshotResult>
let renderer: Renderer | null = null

/** Lets snapshots draw this editor's page (the chat panel registers it); returns the unregister function. */
export function registerSnapshots(editor: Editor) {
	return setSnapshotRenderer((request) => drawSnapshot(editor, request))
}

/** Swaps what draws the pictures (tests pass a fake); returns the function that removes it. */
export function setSnapshotRenderer(next: Renderer) {
	renderer = next
	return () => {
		if (renderer === next) renderer = null
	}
}

export interface SnapshotOptions {
	timeoutMs?: number
	/** Whether the tab can draw; `document.visibilityState` by default. */
	visible?: () => boolean
}

const tabVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible'

/** One picture for the agent, or an error whose message it can pass on to the researcher. */
export async function takeSnapshot(
	request: SnapshotRequest,
	{ timeoutMs = SNAPSHOT_TIMEOUT_MS, visible = tabVisible }: SnapshotOptions = {}
): Promise<SnapshotResult> {
	if (!renderer) throw new Error("The board isn't open in the researcher's browser.")
	// a hidden tab can't be relied on to finish drawing
	if (!visible()) throw new Error("The researcher's tab is in the background, so the board can't be drawn right now.")
	let timer: ReturnType<typeof setTimeout> | undefined
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`Drawing the board took longer than ${timeoutMs / 1000} seconds.`)), timeoutMs)
	})
	try {
		return await Promise.race([renderer(request), late])
	} finally {
		clearTimeout(timer)
	}
}
