import assert from 'node:assert/strict'
import { test } from 'node:test'
import { react } from 'tldraw'
import { defaultPaperCardProps } from '../../shared/shapes.ts'
import { changes, watchBoard } from '../pinboard/changes.ts'
import { pinOffset } from '../widgets/notes.ts'
import { fakeEditor } from './fixtures/fakeEditor.ts'
import { cardUnder, dropNoteAt, gap, placeNote, registerPinNotes, UNPIN_GAP } from './pinNotes.ts'
import { boardToast } from './toast.ts'

// Two cards as getShapePageBounds gives them: Liu 2022's 172 × 70 card, drawn centred on a 48 px
// node at (100, 100); Tirosh 2016 sits 400 px to the right.
const liu = { id: 'shape:paper-liu', box: { x: 38, y: 89, w: 172, h: 70 } }
const tirosh = { id: 'shape:paper-tirosh', box: { x: 438, y: 89, w: 172, h: 70 } }
const cards = [liu, tirosh]
const note = (x: number, y: number) => ({ x, y, w: 160, h: 160 })

test('a point inside a card’s drawn box finds that card, even outside its node', () => {
	assert.equal(cardUnder({ x: 205, y: 95 }, cards)?.id, liu.id) // right of the node, still on the card
	assert.equal(cardUnder({ x: 215, y: 95 }, cards), null) // just past the card's right edge
	assert.equal(cardUnder({ x: 124, y: 160 }, cards), null) // just below it
	// overlapping cards: the one whose centre is nearest
	const close = { id: 'shape:paper-close', box: { x: 138, y: 89, w: 172, h: 70 } }
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

test('the toolbar’s Note dropped on a paper is pinned once, beside the card, with one toast', () => {
	const props = defaultPaperCardProps('pmid:2', { authors: ['Yang Liu'], year: 2022, w: 48, h: 48 })
	const { editor, shapes, bindings, writes } = fakeEditor([{ id: liu.id, type: 'paper-card', x: 100, y: 100, props }])
	const toasts: string[] = []
	const stop = react('board toasts', () => {
		const shown = boardToast.get()
		if (shown) toasts.push(shown.text)
	})
	const cleanups = [watchBoard(editor, 'b_drop'), registerPinNotes(editor)]
	try {
		dropNoteAt(editor, { x: 124, y: 124 }) // the middle of Liu 2022's node
		assert.deepEqual(
			writes.filter((w) => w.includes('binding')),
			['create binding note-pin']
		)
		const [pin] = [...bindings.values()]
		const { dx, dy } = pinOffset(props, 0)
		assert.equal(pin.toId, liu.id)
		assert.deepEqual(pin.props, { dx, dy })
		const note = shapes.get(pin.fromId)!
		assert.deepEqual([note.x, note.y], [100 + dx, 100 + dy])
		assert.deepEqual(toasts, ['Note pinned to Liu 2022. It moves with the paper.'])
		assert.deepEqual(
			changes.get('b_drop').entries.map((e) => e.change),
			[{ type: 'note_added', noteId: note.id, text: '', paperId: 'pmid:2' }]
		)
	} finally {
		stop()
		cleanups.forEach((cleanup) => cleanup())
	}
})
