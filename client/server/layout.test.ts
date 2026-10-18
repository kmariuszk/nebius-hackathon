// Layout v0 (T02): node --test server/layout.test.ts
import type { TLRecord } from '@tldraw/tlschema'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { centre, isFree, MARGIN, placeNear, shapeBoxes, type Box } from './layout.ts'

const shape = (id: string, x: number, y: number, type: string, props: Record<string, unknown>, parentId = 'page:page') =>
	({ typeName: 'shape', id: `shape:${id}`, type, x, y, parentId, props }) as unknown as TLRecord

const card = (id: string, x: number, y: number, size = 48) => shape(id, x, y, 'paper-card', { w: size, h: size })

// deterministic pseudo-random numbers, so a failure can be replayed
function rng(seed: number) {
	return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
}

function placeMany(n: number, seed: number) {
	const random = rng(seed)
	const records: TLRecord[] = [card('first', 0, 0), shape('n', 300, -40, 'note', { scale: 1, growY: 0 })]
	for (let i = 0; i < n; i++) {
		const size = 40 + Math.floor(random() * 5) * 8
		const near = records[Math.floor(random() * records.length)] as unknown as Box & { props: Box }
		const anchor = random() < 0.2 ? null : centre({ x: near.x, y: near.y, w: near.props.w ?? 200, h: near.props.h ?? 200 })
		const { x, y } = placeNear(records, { w: size, h: size }, anchor)
		records.push(card(`p${i}`, x, y, size))
	}
	return records
}

test('200 placements never overlap, margin included', () => {
	const boxes = [...shapeBoxes(placeMany(200, 7)).values()]
	assert.equal(boxes.length, 202)
	boxes.forEach((box, i) => assert.ok(isFree(boxes.slice(0, i), box), `box ${i} overlaps an earlier one`))
})

test('placement is deterministic', () => {
	const a = placeMany(60, 42).map((r) => [(r as { x: number }).x, (r as { y: number }).y])
	const b = placeMany(60, 42).map((r) => [(r as { x: number }).x, (r as { y: number }).y])
	assert.deepEqual(a, b)
})

test('near is respected: the first free ring spot around the anchor, right side first', () => {
	const records = [card('a', 0, 0), card('far', 2000, 2000)]
	const anchor = centre({ x: 0, y: 0, w: 48, h: 48 })
	const p = placeNear(records, { w: 48, h: 48 }, anchor)
	assert.deepEqual(p, { x: 88, y: 0 })
	// with the right side taken, the next angle on the same ring
	const q = placeNear([...records, card('b', p.x, p.y)], { w: 48, h: 48 }, anchor)
	const d = Math.hypot(q.x + 24 - anchor.x, q.y + 24 - anchor.y)
	assert.ok(Math.abs(d - 88) < 1, `expected ring 1, got distance ${d}`)
})

test('without an anchor it goes just right of the content', () => {
	const p = placeNear([card('a', 0, 0), card('b', 500, 300, 80)], { w: 48, h: 48 }, null)
	assert.ok(p.x >= 580 + MARGIN, `x ${p.x}`)
	assert.equal(p.y, 0)
	assert.deepEqual(placeNear([], { w: 48, h: 48 }, null), { x: 176, y: 176 })
})

test('boxes: notes are 200 × scale, arrows take no space, frame children are in page space', () => {
	const boxes = shapeBoxes([
		shape('note', 10, 10, 'note', { scale: 2, growY: 0 }),
		shape('arrow', 0, 0, 'arrow', { start: { x: 0, y: 0 }, end: { x: 500, y: 500 } }),
		shape('frame', 1000, 1000, 'frame', { w: 400, h: 400 }),
		shape('child', 20, 30, 'geo', { w: 10, h: 10 }, 'shape:frame'),
	])
	assert.deepEqual(boxes.get('shape:note'), { x: 10, y: 10, w: 400, h: 400 })
	assert.equal(boxes.has('shape:arrow'), false)
	assert.deepEqual(boxes.get('shape:child'), { x: 1020, y: 1030, w: 10, h: 10 })
})
