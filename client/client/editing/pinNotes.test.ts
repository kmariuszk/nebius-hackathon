import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cardUnder, drawnBox, gap, pinOffset, placeNote, UNPIN_GAP } from './pinNotes.ts'

// Two 48 px nodes: Liu 2022's card is drawn 62 px either side of its node and 11 px above and
// below it (172 × 70 centred on the 48 × 48 node); Tirosh 2016 sits 400 px to the right.
const liu = { id: 'shape:paper-liu', x: 100, y: 100, w: 48, h: 48 }
const tirosh = { id: 'shape:paper-tirosh', x: 500, y: 100, w: 48, h: 48 }
const cards = [liu, tirosh]
const note = (x: number, y: number) => ({ x, y, w: 160, h: 160 })

test('the drawn card is 172 × 70, centred on the node', () => {
	assert.deepEqual(drawnBox(liu), { x: 38, y: 89, w: 172, h: 70 })
})

test('a point inside a card’s drawn box finds that card, even outside its node', () => {
	assert.equal(cardUnder({ x: 205, y: 95 }, cards)?.id, liu.id) // right of the node, still on the card
	assert.equal(cardUnder({ x: 215, y: 95 }, cards), null) // just past the card's right edge
	assert.equal(cardUnder({ x: 124, y: 160 }, cards), null) // just below it
	// overlapping cards: the one whose centre is nearest
	const close = { id: 'shape:paper-close', x: 200, y: 100, w: 48, h: 48 }
	assert.equal(cardUnder({ x: 190, y: 124 }, [liu, close])?.id, close.id)
})

test('a note whose centre is on a card pins to it; one beside it stays as it is', () => {
	assert.deepEqual(placeNote(note(50, 40), null, cards), { pin: liu.id }) // centre (130, 120)
	assert.deepEqual(placeNote(note(250, 40), null, cards), null)
	// a pinned note dropped on another paper moves to it
	assert.deepEqual(placeNote(note(450, 40), liu.id, cards), { pin: tirosh.id })
	// dropped on its own paper again, it's put back beside it
	assert.deepEqual(placeNote(note(50, 40), liu.id, cards), { pin: liu.id })
})

test('a pinned note comes loose only once it’s more than a card’s width from its paper', () => {
	assert.equal(UNPIN_GAP, 172)
	// the card's right edge is at x = 210: a gap of 172 keeps the pin, 173 doesn't
	assert.deepEqual(placeNote(note(210 + 172, 100), liu.id, [liu]), null)
	assert.deepEqual(placeNote(note(210 + 173, 100), liu.id, [liu]), { unpin: true })
	// below and to the left count too
	assert.deepEqual(placeNote(note(-400, 400), liu.id, [liu]), { unpin: true })
	// a free note far from everything stays free; a paper that's gone (hidden) keeps its pin
	assert.deepEqual(placeNote(note(1000, 1000), null, cards), null)
	assert.deepEqual(placeNote(note(1000, 1000), 'shape:paper-gone', cards), null)
})

test('gap between boxes is 0 when they touch and diagonal past a corner', () => {
	assert.equal(gap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }), 0)
	assert.equal(gap({ x: 0, y: 0, w: 10, h: 10 }, { x: 13, y: 14, w: 10, h: 10 }), 5)
})

test('pinned notes go 20 px right of the card, a little below its middle, each next one lower', () => {
	// the drawn card's right edge is node.x + 24 + 86 = node.x + 110
	assert.deepEqual(pinOffset(liu, 0), { dx: 130, dy: 36 })
	assert.deepEqual(pinOffset(liu, 2), { dx: 130, dy: 104 })
	// the same place seedDemo.ts pins the demo note: n1.w / 2 + 106, n1.w / 2 + 12
	assert.deepEqual(pinOffset({ w: 60, h: 60 }, 0), { dx: 60 / 2 + 106, dy: 60 / 2 + 12 })
})
