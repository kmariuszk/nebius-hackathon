import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Editor, TLShapeId } from 'tldraw'
import type { PaperCardProps } from '../../shared/paperCard.ts'
import { defaultPaperCardProps } from '../../shared/shapes.ts'
import { boardDerived, seedLinksOf, seedNote } from './card.ts'

const id = (k: string) => `shape:${k}` as TLShapeId

// A board of cards and arrows, behind the few editor calls the card's note reads.
function board(cards: Record<string, Partial<PaperCardProps>>, links: [from: string, to: string, kind: string][]) {
	const shapes = new Map<string, object>()
	const bindings: { type: 'arrow'; fromId: string; toId: string; props: { terminal: 'start' | 'end' } }[] = []
	for (const [k, props] of Object.entries(cards)) {
		shapes.set(id(k), { id: id(k), type: 'paper-card', props: defaultPaperCardProps(k, props), meta: {} })
	}
	for (const [from, to, kind] of links) {
		const arrow = id(`link-${kind}-${from}--${to}`)
		shapes.set(arrow, { id: arrow, type: 'arrow', props: {}, meta: kind === 'user' ? {} : { kind } })
		bindings.push(
			{ type: 'arrow', fromId: arrow, toId: id(from), props: { terminal: 'start' } },
			{ type: 'arrow', fromId: arrow, toId: id(to), props: { terminal: 'end' } }
		)
	}
	return {
		getCurrentPageShapes: () => [...shapes.values()],
		getShape: (s: string) => shapes.get(s),
		getBindingsToShape: (s: string) => bindings.filter((b) => b.toId === s),
		getBindingsFromShape: (s: string) => bindings.filter((b) => b.fromId === s),
	} as unknown as Editor
}

const seed = { kind: 'seed', status: 'kept' } as const
const fit = (score: number): Partial<PaperCardProps> => ({ scores: { 'new-findings': { score, fit: 'high', why: '' } } })
const cards = { top: fit(0.9), next: fit(0.5), s1: seed, s2: seed, s3: seed, other: fit(0.1) }

test('a card joined to seeds only by similar links is close to them, never cites them', () => {
	const editor = board(cards, [
		['top', 's1', 'similar'],
		['s2', 'top', 'similar'],
		['top', 'other', 'similar'],
		['next', 's3', 'similar'],
	])
	assert.deepEqual(seedLinksOf(editor, id('top')), { cites: 0, close: 2 })
	const { notes } = boardDerived(editor)
	assert.equal(notes.get('top'), 'close to 2 of your seeds')
	assert.ok(![...notes.values()].some((n) => n.includes('cites')))
})

test('a card that cites seeds says so; a seed citing it, or a person’s arrow, doesn’t count', () => {
	const editor = board(cards, [
		['top', 's1', 'cites'],
		['top', 's2', 'cites'],
		['s3', 'top', 'cites'],
		['top', 's3', 'similar'],
		['top', 'other', 'cites'],
	])
	assert.deepEqual(seedLinksOf(editor, id('top')), { cites: 2, close: 1 })
	assert.equal(boardDerived(editor).notes.get('top'), 'cites 2 of your seeds')

	const theirs = board(cards, [['top', 's1', 'user'], ['s2', 'top', 'cites']])
	assert.deepEqual(seedLinksOf(theirs, id('top')), { cites: 0, close: 0 })
	assert.equal(boardDerived(theirs).notes.has('top'), false)
})

test('the note’s wording', () => {
	assert.equal(seedNote({ cites: 0, close: 0 }), null)
	assert.equal(seedNote({ cites: 1, close: 0 }), 'cites 1 of your seeds')
	assert.equal(seedNote({ cites: 1, close: 3 }), 'cites 1 of your seeds')
	assert.equal(seedNote({ cites: 0, close: 1 }), 'close to 1 of your seeds')
	assert.equal(seedNote({ cites: 0, close: 4 }), 'close to 4 of your seeds')
})
