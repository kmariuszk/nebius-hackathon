import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PaperQuote } from '../../shared/paperCard.ts'
import { sourceLabel, splitClaims } from './claims.ts'

const quote = (id: string, verified = true): PaperQuote => ({
	id,
	text: `Quote ${id}.`,
	source: 'abstract',
	verified,
	url: `https://pubmed.ncbi.nlm.nih.gov/1/#:~:text=${id}`,
})
const quotes = [quote('q1'), quote('q2'), quote('q3', false)]
const line =
	'Isolates CD8+ T cells clustered with tumour cells from melanoma metastases and finds them tumour-reactive, building on three of your seeds.'

test('splits oneLine into plain text and claims, in order', () => {
	const { segments, unplaced } = splitClaims(
		line,
		[
			{ text: 'three of your seeds', evidence: ['seeds'] },
			{ text: 'CD8+ T cells clustered with tumour cells', evidence: ['q1'] },
			{ text: 'tumour-reactive', evidence: ['q2'] },
		],
		quotes
	)
	assert.equal(segments.map((s) => s.text).join(''), line)
	assert.deepEqual(
		segments.filter((s) => s.claim).map((s) => [s.text, s.claim!.index]),
		[
			['CD8+ T cells clustered with tumour cells', 1],
			['tumour-reactive', 2],
			['three of your seeds', 0],
		]
	)
	assert.deepEqual(unplaced, [])
	const seeds = segments.find((s) => s.text === 'three of your seeds')!.claim!
	assert.equal(seeds.seeds, true)
	assert.equal(seeds.verified, true)
	assert.deepEqual(seeds.quotes, [])
	const q1 = segments.find((s) => s.claim?.index === 1)!.claim!
	assert.deepEqual(q1.quotes.map((q) => q.id), ['q1'])
	assert.equal(q1.verified, true)
})

test('a claim missing from oneLine is left out and reported', () => {
	const { segments, unplaced } = splitClaims(
		line,
		[
			{ text: 'not in the sentence', evidence: ['q1'] },
			{ text: 'tumour-reactive', evidence: ['q2'] },
		],
		quotes
	)
	assert.equal(segments.map((s) => s.text).join(''), line)
	assert.deepEqual(unplaced, [0])
	assert.deepEqual(segments.filter((s) => s.claim).map((s) => s.claim!.index), [1])
})

test('overlapping claims: the earlier wins, the longer on a tie, and nothing is cut twice', () => {
	const { segments, unplaced } = splitClaims(
		line,
		[
			{ text: 'T cells clustered', evidence: ['q1'] },
			{ text: 'CD8+ T cells', evidence: ['q2'] },
			{ text: 'CD8+ T cells clustered with tumour cells', evidence: ['q1'] },
		],
		quotes
	)
	assert.equal(segments.map((s) => s.text).join(''), line)
	assert.deepEqual(
		segments.filter((s) => s.claim).map((s) => s.text),
		['CD8+ T cells clustered with tumour cells']
	)
	assert.deepEqual(unplaced, [0, 1])
})

test('a claim is matched ignoring case when the model changed it', () => {
	const { segments } = splitClaims(line, [{ text: 'Tumour-Reactive', evidence: ['q2'] }], quotes)
	assert.deepEqual(segments.filter((s) => s.claim).map((s) => s.text), ['tumour-reactive'])
})

test('unknown quote IDs are flagged and make the claim unverified', () => {
	const { segments } = splitClaims(
		line,
		[
			{ text: 'tumour-reactive', evidence: ['q2', 'q9'] },
			{ text: 'melanoma metastases', evidence: ['q3'] },
			{ text: 'building on', evidence: [] },
		],
		quotes
	)
	const byText = Object.fromEntries(segments.filter((s) => s.claim).map((s) => [s.text, s.claim!]))
	assert.deepEqual(byText['tumour-reactive'].unknown, ['q9'])
	assert.deepEqual(byText['tumour-reactive'].quotes.map((q) => q.id), ['q2'])
	assert.equal(byText['tumour-reactive'].verified, false)
	// a quote not found word for word
	assert.equal(byText['melanoma metastases'].verified, false)
	// no evidence at all
	assert.equal(byText['building on'].verified, false)
})

test('empty oneLine gives no segments', () => {
	assert.deepEqual(splitClaims('', [{ text: 'x', evidence: [] }], quotes), { segments: [], unplaced: [0] })
})

test('quote links name their source', () => {
	assert.equal(sourceLabel('https://pubmed.ncbi.nlm.nih.gov/41261135/#:~:text=Here'), 'PubMed')
	assert.equal(sourceLabel('https://pmc.ncbi.nlm.nih.gov/articles/PMC1/'), 'PubMed Central')
	assert.equal(sourceLabel('https://www.biorxiv.org/content/1'), 'biorxiv.org')
	assert.equal(sourceLabel('not a url'), 'Source')
})
