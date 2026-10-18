import type { TLRecord, TLShape } from '@tldraw/tlschema'

// Layout v0 (T02): agents never send coordinates; a new shape goes on the nearest free spot
// around an anchor. Deterministic, and it never moves anything already on the board.

export interface Vec {
	x: number
	y: number
}

export interface Box extends Vec {
	w: number
	h: number
}

/** Free space kept around every placed box. */
export const MARGIN = 24
const RING_GAP = 40
const MAX_RINGS = 1000
const NOTE_SIZE = 200
// where the first shape on an empty page goes
const EMPTY_PAGE_ANCHOR = { x: 200, y: 200 }

const isShape = (r: TLRecord): r is TLShape => r.typeName === 'shape'

// The server has no geometry engine, so boxes come from props: w/h, notes at 200 × scale, a text
// line at 40 × scale. Arrows, and shapes with no size in their props (draw, line), take no space.
function ownSize(shape: TLShape): { w: number; h: number } | null {
	const p = shape.props as Record<string, unknown>
	const scale = typeof p.scale === 'number' ? p.scale : 1
	if (shape.type === 'arrow') return null
	if (shape.type === 'note') {
		const growY = typeof p.growY === 'number' ? p.growY : 0
		return { w: NOTE_SIZE * scale, h: (NOTE_SIZE + growY) * scale }
	}
	if (typeof p.w !== 'number') return null
	if (typeof p.h === 'number') return { w: p.w, h: p.h }
	if (shape.type === 'text') return { w: p.w * scale, h: 40 * scale }
	return null
}

/** Page-space boxes of the shapes among `records` (children of frames and groups included; rotation ignored). */
export function shapeBoxes(records: Iterable<TLRecord>): Map<string, Box> {
	const shapes = new Map<string, TLShape>()
	for (const r of records) if (isShape(r)) shapes.set(r.id, r)
	const offset = (shape: TLShape): Vec => {
		const parent = shapes.get(shape.parentId)
		if (!parent) return { x: shape.x, y: shape.y }
		const o = offset(parent)
		return { x: o.x + shape.x, y: o.y + shape.y }
	}
	const boxes = new Map<string, Box>()
	for (const shape of shapes.values()) {
		const size = ownSize(shape)
		if (size) boxes.set(shape.id, { ...offset(shape), ...size })
	}
	return boxes
}

export const centre = (b: Box): Vec => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

/** True if `box`, grown by MARGIN on every side, touches none of `boxes`. */
export function isFree(boxes: Iterable<Box>, box: Box): boolean {
	const grown = { x: box.x - MARGIN, y: box.y - MARGIN, w: box.w + 2 * MARGIN, h: box.h + 2 * MARGIN }
	for (const b of boxes) if (overlaps(grown, b)) return false
	return true
}

/** Content bounds, or null for an empty page. */
export function bounds(boxes: Iterable<Box>): Box | null {
	let minX = Infinity
	let minY = Infinity
	let maxX = -Infinity
	let maxY = -Infinity
	for (const b of boxes) {
		minX = Math.min(minX, b.x)
		minY = Math.min(minY, b.y)
		maxX = Math.max(maxX, b.x + b.w)
		maxY = Math.max(maxY, b.y + b.h)
	}
	return minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * Top-left for a new box of `size`: the first spot on rings around `anchor` (radius k × (size + 40),
 * 8 angles per ring, nearest first) that keeps MARGIN clear of every shape among `records`. With
 * no anchor, it starts just right of the page's content. A batch places shapes one by one, each
 * call seeing the shapes placed before it.
 */
export function placeNear(records: Iterable<TLRecord>, size: { w: number; h: number }, anchor: Vec | null): Vec {
	const boxes = [...shapeBoxes(records).values()]
	const content = bounds(boxes)
	const start =
		anchor ??
		(content
			? { x: content.x + content.w + RING_GAP + size.w / 2, y: content.y + size.h / 2 }
			: EMPTY_PAGE_ANCHOR)
	const step = Math.max(size.w, size.h) + RING_GAP
	for (let k = 0; k <= MAX_RINGS; k++) {
		for (let i = 0; i < (k === 0 ? 1 : 8); i++) {
			const angle = (i * Math.PI) / 4
			const x = Math.round(start.x + k * step * Math.cos(angle) - size.w / 2)
			const y = Math.round(start.y + k * step * Math.sin(angle) - size.h / 2)
			if (isFree(boxes, { x, y, ...size })) return { x, y }
		}
	}
	// unreachable in practice: past the outermost shape every spot is free
	return { x: Math.round((content?.x ?? 0) + (content?.w ?? 0) + RING_GAP), y: Math.round(content?.y ?? 0) }
}
