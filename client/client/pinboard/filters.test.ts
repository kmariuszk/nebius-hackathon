import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { Editor } from 'tldraw'
import { paperShapeId } from '../../shared/ids.ts'
import type { PaperCardProps } from '../../shared/paperCard.ts'
import { defaultPaperCardProps } from '../../shared/shapes.ts'
import { boardDerived } from '../shapes/card.ts'
import { currentGoal, filters, type BoardFilters } from '../viewerState.ts'
import { boardSteps } from '../widgets/tour.ts'
import { activeCount, DEFAULT_FILTERS, filterOptions, passes, sinceYears, toggled } from './filters.ts'

afterEach(() => {
	filters.set(DEFAULT_FILTERS)
	currentGoal.set('new-findings')
})

const GOAL = 'new-findings'
const scored = (score: number, fit: 'low' | 'medium' | 'high', why = '') => ({ [GOAL]: { score, fit, why } })
const methods = (score: number, fit: 'low' | 'medium' | 'high') => ({ methods: { score, fit, why: '' } })
const card = (props: Partial<PaperCardProps> = {}) => defaultPaperCardProps('p', { type: 'article', ...props })
const only = (patch: Partial<BoardFilters>): BoardFilters => ({ ...DEFAULT_FILTERS, ...patch })

/* ---------- the predicates ---------- */

test('with no filter on, every suggestion passes, scored or not; discarded ones only when shown', () => {
	for (const props of [{}, { scores: scored(0.2, 'low') }, { type: 'preprint' as const }, { type: 'other' as const }]) {
		assert.equal(passes(card(props), DEFAULT_FILTERS, GOAL), true)
	}
	const gone = card({ status: 'discarded' })
	assert.equal(passes(gone, DEFAULT_FILTERS, GOAL), false)
	assert.equal(passes(gone, only({ showDiscarded: true }), GOAL), true)
})

test('seeds and kept papers always pass, whatever the filters', () => {
	const strict = only({ fit: [], types: [], peerReviewedOnly: true, minCitedBy: 50, yearFrom: 2025 })
	assert.equal(passes(card({ kind: 'seed', status: 'kept', type: 'preprint' }), strict, GOAL), true)
	assert.equal(passes(card({ kind: 'kept', status: 'kept', citedBy: 0 }), strict, GOAL), true)
	assert.equal(passes(card(), strict, GOAL), false)
})

test('fit is for the current goal, and a paper with no score for it has no fit', () => {
	const methodsHigh = card({ scores: { ...scored(0.2, 'low'), methods: { score: 0.9, fit: 'high', why: '' } } })
	const highOnly = only({ fit: ['high'] })
	assert.equal(passes(methodsHigh, highOnly, GOAL), false)
	assert.equal(passes(methodsHigh, highOnly, 'methods'), true)
	assert.equal(passes(methodsHigh, only({ fit: ['low', 'medium'] }), GOAL), true)
	assert.equal(passes(card(), highOnly, GOAL), false)
})

test('type: articles, reviews and preprints; other (an OpenAlex book chapter) goes with articles', () => {
	const noReviews = only({ types: ['article', 'preprint', 'other'] })
	assert.equal(passes(card({ type: 'review' }), noReviews, GOAL), false)
	assert.equal(passes(card({ type: 'article' }), noReviews, GOAL), true)
	assert.equal(passes(card({ type: 'other' }), noReviews, GOAL), true)
	// the Article chip turns both off
	const noArticles = only({ types: toggled(DEFAULT_FILTERS.types, ['article', 'other']) })
	assert.deepEqual(noArticles.types, ['review', 'preprint'])
	assert.equal(passes(card({ type: 'other' }), noArticles, GOAL), false)
	assert.equal(passes(card({ type: 'preprint' }), noArticles, GOAL), true)
})

test('peer reviewed only hides preprints and peerReviewed: false; unknown (null) stays', () => {
	const peer = only({ peerReviewedOnly: true })
	assert.equal(passes(card({ type: 'preprint' }), peer, GOAL), false)
	assert.equal(passes(card({ type: 'preprint', peerReviewed: null }), peer, GOAL), false)
	assert.equal(passes(card({ peerReviewed: false }), peer, GOAL), false)
	assert.equal(passes(card({ peerReviewed: null }), peer, GOAL), true)
	assert.equal(passes(card({ type: 'review', peerReviewed: true }), peer, GOAL), true)
})

test('cited at least: below the count fails, and a missing citedBy counts as uncited', () => {
	const fifty = only({ minCitedBy: 50 })
	assert.equal(passes(card({ citedBy: 122 }), fifty, GOAL), true)
	assert.equal(passes(card({ citedBy: 50 }), fifty, GOAL), true)
	assert.equal(passes(card({ citedBy: 24 }), fifty, GOAL), false)
	assert.equal(passes(card({ citedBy: null }), fifty, GOAL), false)
	assert.equal(passes(card({ citedBy: null }), only({ minCitedBy: 0 }), GOAL), true)
})

test('from year: that year and later pass; no year fails', () => {
	const since = only({ yearFrom: 2023 })
	assert.equal(passes(card({ year: 2023 }), since, GOAL), true)
	assert.equal(passes(card({ year: 2022 }), since, GOAL), false)
	assert.equal(passes(card({ year: null }), since, GOAL), false)
	assert.deepEqual(sinceYears(2026), [2023, 2025])
})

test('filters combine: a paper must pass every one', () => {
	const f = only({ fit: ['high', 'medium'], peerReviewedOnly: true, minCitedBy: 10, yearFrom: 2020 })
	const good = { scores: scored(0.8, 'high'), citedBy: 86, year: 2022 }
	assert.equal(passes(card(good), f, GOAL), true)
	assert.equal(passes(card({ ...good, scores: scored(0.3, 'low') }), f, GOAL), false)
	assert.equal(passes(card({ ...good, type: 'preprint' }), f, GOAL), false)
	assert.equal(passes(card({ ...good, citedBy: 9 }), f, GOAL), false)
	assert.equal(passes(card({ ...good, year: 2019 }), f, GOAL), false)
})

test('the count of active filters', () => {
	assert.equal(activeCount(DEFAULT_FILTERS), 0)
	assert.equal(activeCount(only({ fit: ['high'] })), 1)
	assert.equal(activeCount(only({ types: ['article', 'review', 'preprint'] })), 1)
	assert.equal(activeCount(only({ peerReviewedOnly: true, minCitedBy: 10, yearFrom: 2025, showDiscarded: true })), 4)
	assert.equal(activeCount(only({ fit: [], types: [], peerReviewedOnly: true, minCitedBy: 50, yearFrom: 2023, showDiscarded: true })), 6)
	// the same values in another order are no filter
	assert.equal(activeCount(only({ fit: ['high', 'low', 'medium'] })), 0)
})

test('a chip toggles all of its values together', () => {
	assert.deepEqual(toggled(['low', 'medium', 'high'], ['medium']), ['low', 'high'])
	assert.deepEqual(toggled(['low', 'high'], ['medium']), ['low', 'high', 'medium'])
	// half on turns the rest on
	assert.deepEqual(toggled(['review', 'other'], ['article', 'other']), ['review', 'other', 'article'])
})

/* ---------- what the panel offers ---------- */

const props = (paperId: string, p: Partial<PaperCardProps>) => defaultPaperCardProps(paperId, { type: 'article', ...p })

test('the panel leaves out options no suggestion has data for', () => {
	const cards = [
		props('a', { scores: scored(0.9, 'high'), year: 2019 }),
		props('b', { scores: scored(0.5, 'medium'), type: 'other', year: 2021 }),
		props('seed', { kind: 'seed', status: 'kept', type: 'preprint', citedBy: 4551, year: 2026, peerReviewed: false }),
	]
	const o = filterOptions(cards, DEFAULT_FILTERS, GOAL, 2026)
	assert.deepEqual(o.fits, ['high', 'medium'])
	assert.deepEqual(o.types.map((t) => t.label), ['Article'])
	// a seed's preprint, citation count and year don't count: seeds aren't filtered
	assert.equal(o.peerReviewed, false)
	assert.equal(o.citedBy, false)
	assert.deepEqual(o.years, [])
	assert.equal(o.discarded, 0)
	assert.equal(o.showDiscarded, false)
	assert.equal(o.best?.paperId, 'a')
})

test('the panel offers what the suggestions have, and keeps an option the viewer set', () => {
	const cards = [
		props('a', { scores: scored(0.4, 'low'), citedBy: 12, year: 2024 }),
		props('b', { scores: scored(0.8, 'high'), type: 'review', citedBy: 3, year: 2026 }),
		props('c', { type: 'preprint', year: 2025 }),
		props('d', { status: 'discarded', scores: scored(0.99, 'medium'), year: 2026 }),
	]
	const o = filterOptions(cards, DEFAULT_FILTERS, GOAL, 2026)
	assert.deepEqual(o.fits, ['high', 'low'])
	assert.deepEqual(o.types.map((t) => t.label), ['Article', 'Review', 'Preprint'])
	assert.equal(o.peerReviewed, true)
	assert.equal(o.citedBy, true)
	assert.deepEqual(o.years, [2023, 2025])
	assert.equal(o.discarded, 1)
	assert.equal(o.showDiscarded, true)
	assert.equal(o.best?.paperId, 'b')

	// shown discarded papers count: d is the best match now, and its fit is offered
	const shown = filterOptions(cards, only({ showDiscarded: true }), GOAL, 2026)
	assert.deepEqual(shown.fits, ['high', 'medium', 'low'])
	assert.equal(shown.best?.paperId, 'd')

	// a filter the viewer set stays on offer, so that it can be undone
	const bare = [props('x', {})]
	const set = filterOptions(bare, only({ fit: ['high'], types: ['article', 'other'], minCitedBy: 50, yearFrom: 2025, peerReviewedOnly: true, showDiscarded: true }), GOAL, 2026)
	assert.deepEqual(set.fits, ['medium', 'low'])
	assert.deepEqual(set.types.map((t) => t.label), ['Article', 'Review', 'Preprint'])
	assert.equal(set.citedBy, true)
	assert.equal(set.peerReviewed, true)
	assert.deepEqual(set.years, [2025])
	assert.equal(set.showDiscarded, true)
})

/* ---------- the board follows the filters ---------- */

// A board behind the few editor calls boardDerived and the tour read: cards, and `cites` arrows.
function board(papers: Record<string, Partial<PaperCardProps>>, cites: [from: string, to: string][] = []) {
	const shapes = new Map<string, { id: string; type: string; props?: PaperCardProps; meta: object }>()
	const bindings: { type: 'arrow'; fromId: string; toId: string; props: { terminal: 'start' | 'end' } }[] = []
	for (const [paperId, p] of Object.entries(papers)) {
		const id = paperShapeId(paperId)
		shapes.set(id, { id, type: 'paper-card', props: props(paperId, p), meta: {} })
	}
	for (const [from, to] of cites) {
		const arrow = `shape:cites-${from}--${to}`
		shapes.set(arrow, { id: arrow, type: 'arrow', meta: { kind: 'cites' } })
		bindings.push(
			{ type: 'arrow', fromId: arrow, toId: paperShapeId(from), props: { terminal: 'start' } },
			{ type: 'arrow', fromId: arrow, toId: paperShapeId(to), props: { terminal: 'end' } }
		)
	}
	return {
		getCurrentPageId: () => 'page:1',
		getCurrentPageShapes: () => [...shapes.values()],
		getShape: (id: string) => shapes.get(id),
		getAncestorPageId: () => 'page:1',
		isShapeHidden: () => false,
		getBindingsToShape: (id: string) => bindings.filter((b) => b.toId === id),
		getBindingsFromShape: (id: string) => bindings.filter((b) => b.fromId === id),
	} as unknown as Editor
}

const paperIds = (cards: { props: { paperId: string } }[]) => cards.map((s) => s.props.paperId)

// the demo board's citation counts: Liu 2022 has 122, Sade-Feldman 86, Oliveira 24, the preprint 0
const demo = () =>
	board(
		{
			oliveira: { scores: { ...scored(0.9, 'high', 'Cites 3 of your seeds.'), ...methods(0.3, 'low') }, citedBy: 24, year: 2025 },
			liu: { scores: { ...scored(0.4, 'low'), ...methods(0.9, 'high') }, citedBy: 122, year: 2022 },
			preprint: { scores: scored(0.6, 'medium'), type: 'preprint', citedBy: 0, year: 2026 },
			sade: { scores: scored(0.5, 'medium'), citedBy: 86, year: 2018, status: 'contested' },
			dropped: { scores: scored(0.95, 'high'), citedBy: 300, status: 'discarded' },
			seed: { kind: 'seed', status: 'kept', citedBy: 4551 },
		},
		[
			['oliveira', 'seed'],
			['liu', 'seed'],
		]
	)

test('cited at least 50×: the list, the red numbers and Catch me up all leave the rest out', () => {
	const editor = demo()
	const before = boardDerived(editor)
	assert.deepEqual(paperIds(before.ranked), ['oliveira', 'preprint', 'sade', 'liu'])
	assert.equal(before.total, 4)
	assert.deepEqual(before.fresh, ['oliveira', 'preprint', 'liu'])

	filters.set(only({ minCitedBy: 50 }))
	const after = boardDerived(editor)
	assert.deepEqual(paperIds(after.ranked), ['sade', 'liu'])
	assert.equal(after.total, 4)
	assert.deepEqual([...after.ranks], [['sade', 1], ['liu', 2]])
	assert.deepEqual(after.fresh, ['liu'])
	assert.deepEqual(boardSteps(editor).map((s) => s.paperId), ['liu'])

	// Clear restores everything
	filters.set(DEFAULT_FILTERS)
	assert.deepEqual(paperIds(boardDerived(editor).ranked), ['oliveira', 'preprint', 'sade', 'liu'])
	assert.deepEqual(boardSteps(editor).map((s) => s.paperId), ['oliveira', 'preprint', 'liu'])
})

test('the ranks always match the list’s order, under any filter and goal', () => {
	const editor = demo()
	for (const goal of [GOAL, 'methods']) {
		currentGoal.set(goal)
		for (const f of [only({ peerReviewedOnly: true }), only({ fit: ['medium'] }), only({ fit: ['high'] }), only({ yearFrom: 2023 }), only({ types: ['preprint'] })]) {
			filters.set(f)
			const { ranked, ranks } = boardDerived(editor)
			assert.deepEqual([...ranks.keys()], paperIds(ranked))
			assert.deepEqual([...ranks.values()], ranked.map((_, i) => i + 1))
		}
	}
	currentGoal.set(GOAL)
	filters.set(only({ peerReviewedOnly: true }))
	assert.deepEqual(paperIds(boardDerived(editor).ranked), ['oliveira', 'sade', 'liu'])
	filters.set(only({ yearFrom: 2023 }))
	assert.deepEqual(paperIds(boardDerived(editor).ranked), ['oliveira', 'preprint'])
	// high fit is for the viewer's goal: Liu 2022 is low for new findings, high for methods
	filters.set(only({ fit: ['high'] }))
	assert.deepEqual(paperIds(boardDerived(editor).ranked), ['oliveira'])
	currentGoal.set('methods')
	assert.deepEqual(paperIds(boardDerived(editor).ranked), ['liu'])
})

test('the seed note goes to the top new card that passes; showing discarded papers ranks them too', () => {
	const editor = demo()
	assert.equal(boardDerived(editor).notes.get('oliveira'), 'cites 1 of your seeds')
	assert.equal(boardDerived(editor).notes.get('preprint'), 'preprint, not peer reviewed')

	filters.set(only({ fit: ['low'] }))
	const low = boardDerived(editor)
	assert.equal(low.ranks.has('oliveira'), false)
	assert.equal(low.notes.get('liu'), 'cites 1 of your seeds')
	assert.equal(low.notes.has('oliveira'), false)

	filters.set(only({ showDiscarded: true }))
	const shown = boardDerived(editor)
	assert.deepEqual(paperIds(shown.ranked), ['dropped', 'oliveira', 'preprint', 'sade', 'liu'])
	assert.equal(shown.total, 5)
	// a discarded paper is never new, so Catch me up doesn't change
	assert.deepEqual(shown.fresh, ['oliveira', 'preprint', 'liu'])
})
