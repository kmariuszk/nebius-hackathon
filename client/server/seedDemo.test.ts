// The demo board (seedDemo.ts) as the browser draws it: node --test server/seedDemo.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CARD_SIZE } from '../shared/shapes.ts'
import { isFree, type Box } from './layout.ts'
import { shapes } from './seedDemo.ts'

type Placed = { id: string; type: string; x: number; y: number; props: { w: number; h: number; scale: number; growY: number } }
const placed = shapes as Placed[]

// a CARD_SIZE card centred on each node (the browser's cardOffset)
const cards = placed
	.filter((s) => s.type === 'paper-card')
	.map((s) => ({
		id: s.id,
		box: { x: s.x + s.props.w / 2 - CARD_SIZE.w / 2, y: s.y + s.props.h / 2 - CARD_SIZE.h / 2, w: CARD_SIZE.w, h: CARD_SIZE.h },
	}))

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

test('no two of the demo board’s cards overlap as drawn, margin included', () => {
	assert.equal(cards.length, 10)
	cards.forEach(({ id, box }, i) => assert.ok(isFree(cards.slice(0, i).map((c) => c.box), box), `${id} overlaps another card`))
})

test('the demo board’s pinned note covers no card', () => {
	const note = placed.find((s) => s.type === 'note')!
	const { scale, growY } = note.props
	const box = { x: note.x, y: note.y, w: 200 * scale, h: (200 + growY) * scale }
	for (const c of cards) assert.equal(overlaps(c.box, box), false, `the note covers ${c.id}`)
})
