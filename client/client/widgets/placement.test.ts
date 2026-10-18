import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	BOTTOM,
	NARROW_WIDTH,
	TOP,
	WIDE_MIN,
	WIDE_WIDTH,
	focusCamera,
	focusZoom,
	layoutWidgets,
	type Layout,
	type LayoutInput,
	type Rect,
} from './placement.ts'

// heights from the mockup's first view (1-open.png) and with More open (2-more.png)
const firstView = (width: number, height: number): LayoutInput => ({
	width,
	height,
	title: 100,
	actions: 56,
	left: [
		{ key: 'glance', h: 354 },
		{ key: 'figure', h: 230 },
	],
	right: [
		{ key: 'why', h: 180 },
		{ key: 'notes', h: 150 },
	],
})
const withMore = (width: number, height: number): LayoutInput => {
	const input = firstView(width, height)
	return { ...input, right: [...input.right, { key: 'evidence', h: 900, maxH: 420, minH: 160 }] }
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

function assertNoOverlap(layout: Layout) {
	const rects = Object.entries(layout.rects)
	for (const [key, r] of rects) {
		assert.ok(!overlaps(r, layout.nodeBox), `${key} overlaps the node`)
		for (const [other, s] of rects) if (other !== key) assert.ok(!overlaps(r, s), `${key} overlaps ${other}`)
	}
}

function assertOnCanvas(layout: Layout, width: number) {
	const originX = layout.home.x - layout.node.x * layout.scale
	for (const [key, r] of Object.entries(layout.rects)) {
		const left = originX + r.x * layout.scale
		assert.ok(left >= 0 && left + r.w * layout.scale <= width, `${key} is off the canvas`)
	}
}

const sizes: [number, number][] = [
	[1440, 757],
	[1280, 720],
	[1100, 900],
	[1099, 900],
	[1000, 700],
	[760, 640],
	[2200, 1300],
]

test('widgets never overlap each other or the node, and stay on the canvas', () => {
	for (const [w, h] of sizes) {
		for (const input of [firstView(w, h), withMore(w, h)]) {
			const layout = layoutWidgets(input)
			assertNoOverlap(layout)
			assertOnCanvas(layout, w)
		}
	}
})

test('wide canvases get three columns, narrow ones two', () => {
	assert.equal(layoutWidgets(firstView(WIDE_MIN, 800)).mode, 'wide')
	assert.equal(layoutWidgets(firstView(WIDE_MIN - 1, 800)).mode, 'narrow')
	const wide = layoutWidgets(firstView(1440, 800))
	assert.equal(wide.width, WIDE_WIDTH)
	assert.deepEqual(wide.columns.left?.keys, ['glance', 'figure'])
	assert.deepEqual(wide.columns.right.keys, ['why', 'notes'])
	assert.ok(wide.rects.glance.x < wide.rects.title.x && wide.rects.title.x < wide.rects.why.x)
})

test('the narrow layout puts the left column after the first widget on the right', () => {
	const narrow = layoutWidgets(withMore(1000, 800))
	assert.equal(narrow.width, NARROW_WIDTH)
	assert.equal(narrow.columns.left, null)
	assert.deepEqual(narrow.columns.right.keys, ['why', 'glance', 'figure', 'notes', 'evidence'])
	assert.ok(narrow.rects.why.x > narrow.rects.title.x)
})

test('the group scales down to fit the width, never up', () => {
	assert.equal(layoutWidgets(firstView(2200, 900)).scale, 1)
	const narrow = layoutWidgets(firstView(760, 900))
	assert.ok(narrow.scale < 1)
	assert.ok(Math.abs(narrow.width * narrow.scale - (760 - 32)) < 1e-9)
})

test('a side column lines its first widget up with the node when it fits', () => {
	const layout = layoutWidgets(firstView(1440, 1000))
	const why = layout.rects.why
	assert.equal(why.y, layout.node.y - 90)
	assert.ok(why.y < layout.node.y && layout.node.y < why.y + why.h)
	assert.equal(layout.columns.right.maxH, null)
})

test('a column that runs out of room shrinks the quotes, then moves up, then scrolls', () => {
	const roomy = layoutWidgets(withMore(1440, 1400))
	assert.equal(roomy.rects.evidence.h, 420)
	assert.equal(roomy.limits.evidence, 420)

	const short = layoutWidgets(withMore(1440, 700))
	const avail = (700 - TOP - BOTTOM) / short.scale
	assert.ok(short.rects.evidence.h < 420 && short.rects.evidence.h >= 160)
	const bottom = short.rects.evidence.y + short.rects.evidence.h
	assert.ok(bottom <= avail + 1e-9 || short.columns.right.maxH !== null)

	const tiny = layoutWidgets(withMore(1440, 420))
	assert.equal(tiny.rects.evidence.h, 160)
	assert.equal(tiny.columns.right.y, 0)
	assert.ok(tiny.columns.right.maxH !== null && tiny.columns.right.maxH > 0)
	assertNoOverlap(tiny)
})

test('the camera zoom keeps linked papers on the canvas, within limits', () => {
	const canvas = { width: 1440, height: 760 }
	const node = { x: 1000, y: 500 }
	const home = { x: 720, y: 250 }
	assert.equal(focusZoom(node, home, [], canvas), 0.72)
	const z = focusZoom(node, home, [{ x: 400, y: 150, r: 30 }], canvas)
	assert.ok(z < 0.72 && z >= 0.42)
	// the linked paper lands on the canvas
	const cam = focusCamera(node, home, z)
	const px = (400 + cam.x) * z
	assert.ok(px - (30 + 36) * z >= 15)
	assert.equal(focusZoom(node, home, [{ x: -50000, y: 500, r: 30 }], canvas), 0.42)
})

test('the camera puts the node at its home point', () => {
	const node = { x: 1060, y: 500 }
	const home = { x: 700, y: 260 }
	const cam = focusCamera(node, home, 0.6)
	assert.ok(Math.abs((node.x + cam.x) * cam.z - home.x) < 1e-9)
	assert.ok(Math.abs((node.y + cam.y) * cam.z - home.y) < 1e-9)
})
