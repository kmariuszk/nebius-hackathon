import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PaperCardProps } from '../../shared/paperCard.ts'
import { defaultPaperCardProps } from '../../shared/shapes.ts'
import { emptyState } from './emptyStates.ts'

const card = (props: Partial<PaperCardProps> = {}) => defaultPaperCardProps('pmid:1', props)
const figure = { imageUrl: 'https://example.org/f3.png', label: 'Fig. 3', caption: '', captionByAi: false }
const glance = [{ label: 'Finding', text: 'Clustered T cells kill melanoma.', quoteId: null, relation: null }]

test('while the agent reads, each widget shows its loading line', () => {
	const reading = card({ working: true })
	assert.deepEqual(emptyState(reading, 'why'), { kind: 'working' })
	assert.deepEqual(emptyState(reading, 'glance'), { kind: 'working' })
	assert.deepEqual(emptyState(reading, 'figure'), { kind: 'working' })
	// what has arrived shows; Why keeps its "Still reading" line under it until the pass ends
	assert.deepEqual(emptyState(card({ working: true, oneLine: 'Isolates CD8+ T cells.' }), 'why'), { kind: 'working' })
	assert.deepEqual(emptyState(card({ working: true, glance, figure }), 'glance'), { kind: 'filled' })
	assert.deepEqual(emptyState(card({ working: true, glance, figure }), 'figure'), { kind: 'filled' })
})

test('a finished card shows what it has', () => {
	const done = card({ oneLine: 'Isolates CD8+ T cells.', glance, figure })
	assert.deepEqual(emptyState(done, 'why'), { kind: 'filled' })
	assert.deepEqual(emptyState(done, 'glance'), { kind: 'filled' })
	assert.deepEqual(emptyState(done, 'figure'), { kind: 'filled' })
})

test('a failed context pass shows its gap, and nothing spins', () => {
	const failed = card({
		gaps: [
			'Methods not in the abstract',
			"The agent couldn't write why this paper matters: list index out of range",
			"The agent couldn't draw the paper at a glance.",
		],
	})
	assert.deepEqual(emptyState(failed, 'why'), {
		kind: 'ended',
		text: "The agent couldn't write why this paper matters: list index out of range",
	})
	assert.deepEqual(emptyState(failed, 'glance'), { kind: 'ended', text: "The agent couldn't draw the paper at a glance." })
	assert.deepEqual(emptyState(failed, 'figure'), { kind: 'ended', text: 'No free figure for this paper.' })
	// a curly apostrophe matches too
	const curly = 'The agent couldn’t write why this paper matters: it gave no answer'
	assert.deepEqual(emptyState(card({ gaps: [curly] }), 'why'), { kind: 'ended', text: curly })
})

test('without a gap, an empty Why says so and an empty glance is hidden', () => {
	const bare = card({ gaps: ['Methods not in the abstract'] })
	assert.deepEqual(emptyState(bare, 'why'), { kind: 'ended', text: 'The agent hasn’t explained this paper yet.' })
	assert.deepEqual(emptyState(bare, 'glance'), { kind: 'hidden' })
	assert.deepEqual(emptyState(bare, 'figure'), { kind: 'ended', text: 'No free figure for this paper.' })
})

test('a seed is never read: one line in Why, no glance, and a figure only if it has one', () => {
	// even if something marked it as being read, a seed shows no spinner
	for (const working of [false, true]) {
		const seed = card({ kind: 'seed', status: 'kept', working })
		assert.deepEqual(emptyState(seed, 'why'), { kind: 'seed', text: 'One of your seed papers.' })
		assert.deepEqual(emptyState(seed, 'glance'), { kind: 'hidden' })
		assert.deepEqual(emptyState(seed, 'figure'), { kind: 'hidden' })
	}
	const withFigure = card({ kind: 'seed', status: 'kept', figure, glance })
	assert.deepEqual(emptyState(withFigure, 'figure'), { kind: 'filled' })
	assert.deepEqual(emptyState(withFigure, 'glance'), { kind: 'hidden' })
})

test('a kept paper is read like a suggestion', () => {
	const kept = card({ kind: 'kept', status: 'kept', oneLine: 'Isolates CD8+ T cells.' })
	assert.deepEqual(emptyState(kept, 'why'), { kind: 'filled' })
	assert.deepEqual(emptyState(kept, 'figure'), { kind: 'ended', text: 'No free figure for this paper.' })
})
