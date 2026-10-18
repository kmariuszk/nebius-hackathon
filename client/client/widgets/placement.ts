// Where the open paper's widgets go (v5). Each widget always sits in the same place:
//
//                        [ Title ]
//  [ At a glance ]           ●          [ Why it matters to you ]
//  [ Figure ]           [ Actions ]     [ Team notes ]
//                                       [ What supports this ]
//
// Sizes are the mockup's (flashcard-v5.html), in px before scaling. The group scales down to fit
// the canvas width and is anchored to the node, so it moves with the board. A narrow canvas (the
// chat is open) drops the left column into the right one, after the first widget.

export const COL = { left: 330, center: 380, right: 370 }
/** Between columns. */
export const GAP = 34
/** Between widgets in a column. */
export const STACK = 14
export const TOP = 14
/** The space in the centre column the node sits in. */
export const NODE_SPACE = 150
/** Kept clear at the bottom for the toolbar and the bottom controls. */
export const BOTTOM = 64
export const SIDE_MARGIN = 32
export const WIDE_MIN = 1100
export const MIN_SCALE = 0.5
export const WIDE_WIDTH = COL.left + COL.center + COL.right + 2 * GAP
export const NARROW_WIDTH = COL.center + COL.right + GAP

export interface Point {
	x: number
	y: number
}

export interface Rect {
	x: number
	y: number
	w: number
	h: number
}

export interface Item {
	key: string
	/** Measured height, unscaled. */
	h: number
	/** Never taller than this; the widget scrolls inside. */
	maxH?: number
	/** May shrink down to this before the column moves up or scrolls. */
	minH?: number
}

export interface Column {
	x: number
	y: number
	w: number
	/** Set when the column doesn't fit and scrolls. */
	maxH: number | null
	keys: string[]
}

export interface LayoutInput {
	/** The canvas, in screen px. */
	width: number
	height: number
	/** Measured heights of the centre column's widgets. */
	title: number
	actions: number
	/** The side columns as in the wide layout, top to bottom. */
	left: Item[]
	right: Item[]
}

export interface Layout {
	mode: 'wide' | 'narrow'
	scale: number
	/** The group's width, unscaled. */
	width: number
	/** The node's centre in group space. */
	node: Point
	/** The space reserved for the node, in group space. */
	nodeBox: Rect
	/** Where the camera puts the node's centre on the canvas. */
	home: Point
	columns: { center: Column; left: Column | null; right: Column }
	/** Every widget in group space, unscrolled. */
	rects: Record<string, Rect>
	/** Widgets held below their measured height. */
	limits: Record<string, number>
}

export const layoutMode = (canvasWidth: number) => (canvasWidth >= WIDE_MIN ? 'wide' : 'narrow')

export function layoutWidgets(input: LayoutInput): Layout {
	const mode = layoutMode(input.width)
	const width = mode === 'wide' ? WIDE_WIDTH : NARROW_WIDTH
	const scale = Math.max(MIN_SCALE, Math.min(1, (input.width - SIDE_MARGIN) / width))
	const cx = mode === 'wide' ? COL.left + GAP : 0
	const nodeTop = input.title + STACK
	const node = { x: cx + COL.center / 2, y: nodeTop + NODE_SPACE / 2 }
	const rects: Record<string, Rect> = {
		title: { x: cx, y: 0, w: COL.center, h: input.title },
		actions: { x: cx, y: nodeTop + NODE_SPACE + STACK, w: COL.center, h: input.actions },
	}
	const limits: Record<string, number> = {}
	const avail = (input.height - TOP - BOTTOM) / scale

	// a side column lines its first widget up with the node; what doesn't fit shrinks, then moves up, then scrolls
	const side = (items: Item[], x: number, w: number): Column => {
		const heights = items.map((it) => Math.min(it.h, it.maxH ?? Infinity))
		const total = () => heights.reduce((sum, h) => sum + h, 0) + STACK * Math.max(0, items.length - 1)
		let y = items.length ? Math.max(0, node.y - Math.min(heights[0] / 2, 90)) : 0
		let over = y + total() - avail
		items.forEach((it, i) => {
			if (over <= 0 || it.minH === undefined || heights[i] <= it.minH) return
			const cut = Math.min(over, heights[i] - it.minH)
			heights[i] -= cut
			over -= cut
		})
		if (y + total() > avail) y = Math.max(0, avail - total())
		let at = y
		items.forEach((it, i) => {
			if (heights[i] < it.h) limits[it.key] = heights[i]
			rects[it.key] = { x, y: at, w, h: heights[i] }
			at += heights[i] + STACK
		})
		return { x, y, w, maxH: y + total() > avail ? Math.max(0, avail - y) : null, keys: items.map((it) => it.key) }
	}

	const rightItems = mode === 'wide' ? input.right : [...input.right.slice(0, 1), ...input.left, ...input.right.slice(1)]
	const left = mode === 'wide' ? side(input.left, 0, COL.left) : null
	const right = side(rightItems, cx + COL.center + GAP, COL.right)
	const origin = { x: (input.width - width * scale) / 2, y: TOP }
	return {
		mode,
		scale,
		width,
		node,
		nodeBox: { x: cx, y: nodeTop, w: COL.center, h: NODE_SPACE },
		home: { x: origin.x + node.x * scale, y: origin.y + node.y * scale },
		columns: { center: { x: cx, y: 0, w: COL.center, maxH: null, keys: ['title', 'actions'] }, left, right },
		rects,
		limits,
	}
}

export interface Linked extends Point {
	/** Half the paper's size, in page units. */
	r: number
}

/**
 * The zoom that puts the node at `home` with its linked papers still on the canvas (so hovering
 * "your seeds" can show them), zoomed out a little so the board behind stays calm.
 */
export function focusZoom(
	node: Point,
	home: Point,
	linked: Linked[],
	canvas: { width: number; height: number },
	min = 0.42,
	max = 0.72
): number {
	let z = max
	for (const p of linked) {
		const dx = p.x - node.x
		const dy = p.y - node.y
		const r = p.r + 36 // room for the label under it
		if (dx < -1) z = Math.min(z, (home.x - 16) / (r - dx))
		if (dx > 1) z = Math.min(z, (canvas.width - 16 - home.x) / (dx + r))
		if (dy < -1) z = Math.min(z, (home.y - 14) / (r - dy))
		if (dy > 1) z = Math.min(z, (canvas.height - 14 - home.y) / (dy + r))
	}
	return Math.max(min, z)
}

/** The tldraw camera that shows page point `node` at canvas point `home`: (page + camera) × z = canvas. */
export function focusCamera(node: Point, home: Point, z: number) {
	return { x: home.x / z - node.x, y: home.y / z - node.y, z }
}
