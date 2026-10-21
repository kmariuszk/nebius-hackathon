// Layout v0 (T02): node --test server/layout.test.ts
import type { TLRecord } from '@tldraw/tlschema'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CARD_SIZE } from '../shared/shapes.ts'
import { centre, isFree, MARGIN, placeInside, placeNear, shapeBoxes, type Box } from './layout.ts'

const shape = (id: string, x: number, y: number, type: string, props: Record<string, unknown>, parentId = 'page:page') =>
	({ typeName: 'shape', id: `shape:${id}`, type, x, y, parentId, props }) as unknown as TLRecord

const card = (id: string, x: number, y: number, size = 48) => shape(id, x, y, 'paper-card', { w: size, h: size })

// what the browser draws (cardOffset): a CARD_SIZE card centred on each node; other shapes as they are
function drawn(records: TLRecord[], except = ''): Box[] {
	const types = new Map<string, string | undefined>(records.map((r) => [r.id, (r as { type?: string }).type]))
	return [...shapeBoxes(records)]
		.filter(([id]) => id !== except)
		.map(([id, b]) => {
			if (types.get(id) !== 'paper-card') return b
			const c = centre(b)
			return { x: c.x - CARD_SIZE.w / 2, y: c.y - CARD_SIZE.h / 2, w: CARD_SIZE.w, h: CARD_SIZE.h }
		})
}

const assertApart = (boxes: Box[]) =>
	boxes.forEach((box, i) => assert.ok(isFree(boxes.slice(0, i), box), `box ${i} overlaps an earlier one`))

// deterministic pseudo-random numbers, so a failure can be replayed
function rng(seed: number) {
	return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
}

function placeMany(n: number, seed: number) {
	const random = rng(seed)
	const records: TLRecord[] = [card('first', 0, 0), shape('n', 300, -40, 'note', { scale: 1, growY: 0 })]
	for (let i = 0; i < n; i++) {
		// old boards' nodes grew with their links, so sizes still vary
		const size = 40 + Math.floor(random() * 5) * 8
		const near = records[Math.floor(random() * records.length)] as unknown as Box & { props: Box }
		const anchor = random() < 0.2 ? null : centre({ x: near.x, y: near.y, w: near.props.w ?? 200, h: near.props.h ?? 200 })
		const { x, y } = placeNear(records, { w: size, h: size }, anchor)
		records.push(card(`p${i}`, x, y, size))
	}
	return records
}

test('200 cards placed one after another never overlap as drawn, margin included', () => {
	const boxes = drawn(placeMany(200, 7))
	assert.equal(boxes.length, 202)
	assertApart(boxes)
})

test('placement is deterministic', () => {
	const a = placeMany(60, 42).map((r) => [(r as { x: number }).x, (r as { y: number }).y])
	const b = placeMany(60, 42).map((r) => [(r as { x: number }).x, (r as { y: number }).y])
	assert.deepEqual(a, b)
})

test('near is respected: the first free ring around the anchor, 212 px out, right side first', () => {
	const records = [card('a', 0, 0), card('far', 2000, 2000)]
	const anchor = centre({ x: 0, y: 0, w: 48, h: 48 })
	const distance = (p: { x: number; y: number }) => Math.round(Math.hypot(p.x + 24 - anchor.x, p.y + 24 - anchor.y))
	assert.deepEqual(placeNear(records, { w: 48, h: 48 }, anchor), { x: 212, y: 0 })
	// the first ring takes six cards (the spots straight above and below would touch their neighbours), then the next ring
	const rings = []
	for (let i = 0; i < 7; i++) {
		const p = placeNear(records, { w: 48, h: 48 }, anchor)
		rings.push(distance(p))
		records.push(card(`p${i}`, p.x, p.y))
	}
	assert.deepEqual(rings, [212, 212, 212, 212, 212, 212, 424])
	assertApart(drawn(records))
})

test('without an anchor it goes just right of the content', () => {
	const p = placeNear([card('a', 0, 0), card('b', 500, 300, 80)], { w: 48, h: 48 }, null)
	// b's card is drawn up to x 626; the new one starts clear of it and top-aligned with a's
	assert.ok(p.x + 24 - CARD_SIZE.w / 2 >= 626 + MARGIN, `x ${p.x}`)
	assert.equal(p.y, 0)
	assert.deepEqual(placeNear([], { w: 48, h: 48 }, null), { x: 176, y: 176 })
})

test('seeds added one after another with no anchor, as the seed route adds them, are drawn apart', () => {
	const records: TLRecord[] = []
	for (let i = 0; i < 5; i++) {
		const at = placeNear(records, { w: 48, h: 48 }, null)
		records.push(card(`seed${i}`, at.x, at.y))
	}
	assertApart(drawn(records))
})

test('boxes: a card keeps its footprint, notes are 200 × scale, arrows take no space, frame children are in page space', () => {
	const boxes = shapeBoxes([
		card('card', 0, 0),
		card('big', 500, 0, 80),
		shape('note', 10, 10, 'note', { scale: 2, growY: 0 }),
		shape('arrow', 0, 0, 'arrow', { start: { x: 0, y: 0 }, end: { x: 500, y: 500 } }),
		shape('frame', 1000, 1000, 'frame', { w: 400, h: 400 }),
		shape('child', 20, 30, 'geo', { w: 10, h: 10 }, 'shape:frame'),
	])
	assert.deepEqual(boxes.get('shape:card'), { x: -62, y: -11, w: 172, h: 70 })
	assert.deepEqual(boxes.get('shape:big'), { x: 454, y: 0, w: 172, h: 80 })
	assert.deepEqual(boxes.get('shape:note'), { x: 10, y: 10, w: 400, h: 400 })
	assert.equal(boxes.has('shape:arrow'), false)
	assert.deepEqual(boxes.get('shape:child'), { x: 1020, y: 1030, w: 10, h: 10 })
})

test('placeInside: free spots inside a frame, clear of its cards and of shapes over it, until it is full', () => {
	const records: TLRecord[] = [
		shape('frame', 1000, 1000, 'frame', { w: 700, h: 460 }),
		// a card in the frame (frame coordinates) and one on the page lying over it
		shape('child', 100, 60, 'paper-card', { w: 48, h: 48 }, 'shape:frame'),
		card('over', 1400, 1250),
	]
	const frame = { x: 1000, y: 1000, w: 700, h: 460 }
	const inner = { x: frame.x + MARGIN, y: frame.y + MARGIN, w: frame.w - 2 * MARGIN, h: frame.h - 2 * MARGIN }
	const placed: TLRecord[] = []
	for (;;) {
		const spot = placeInside([...records, ...placed], { w: 48, h: 48 }, centre(frame), 'shape:frame')
		if (!spot) break
		const p = [...records, ...placed, card('new', spot.x, spot.y)]
		const box = drawn(p).at(-1)!
		assert.ok(box.x >= inner.x && box.y >= inner.y && box.x + box.w <= inner.x + inner.w && box.y + box.h <= inner.y + inner.h)
		assert.ok(isFree(drawn(p, 'shape:frame').slice(0, -1), box), `spot ${JSON.stringify(spot)} overlaps`)
		placed.push(card(`p${placed.length}`, spot.x, spot.y))
		assert.ok(placed.length < 20, 'never fills forever')
	}
	assert.ok(placed.length >= 2)
	assert.equal(placeInside(records, { w: 48, h: 48 }, null, 'shape:missing'), null)
})
