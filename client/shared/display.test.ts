import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nodeLabel, normaliseType, sentenceCase, shortAuthors } from './display.ts'

test('node labels use the first author and the year', () => {
	assert.equal(nodeLabel(['Ana Ibáñez-Molero', 'Ben Lee'], 2026), 'Ibáñez-Molero 2026')
	assert.equal(nodeLabel(['Jan van der Berg'], 2020), 'van der Berg 2020')
	assert.equal(nodeLabel(['Itay Tirosh'], null), 'Tirosh')
	assert.equal(nodeLabel([], null), 'Unknown')
})

test('bylines shorten to et al. after two authors', () => {
	assert.equal(shortAuthors(['Itay Tirosh']), 'Tirosh')
	assert.equal(shortAuthors(['Itay Tirosh', 'Benjamin Izar']), 'Tirosh and Izar')
	assert.equal(shortAuthors(['Itay Tirosh', 'Benjamin Izar', 'Aviv Regev']), 'Tirosh et al.')
	assert.equal(shortAuthors(['A One', 'B Two', 'C Three', 'et al.']), 'One et al.')
})

test('only all-capital titles change case', () => {
	assert.equal(sentenceCase('SINGLE-CELL ATLAS OF MELANOMA'), 'Single-cell atlas of melanoma')
	assert.equal(sentenceCase('Single-cell atlas of CD8 T cells'), 'Single-cell atlas of CD8 T cells')
	assert.equal(sentenceCase('123'), '123')
})

test('paper types normalise to the four values the validator accepts', () => {
	for (const [raw, type] of [
		['article', 'article'],
		['review', 'review'],
		['preprint', 'preprint'],
		['Article', 'article'],
		['book-chapter', 'other'],
		['dataset', 'other'],
		['letter', 'other'],
		['editorial', 'other'],
		['', 'other'],
		[null, 'other'],
		[undefined, 'other'],
	] as const) {
		assert.equal(normaliseType(raw), type, String(raw))
	}
})
