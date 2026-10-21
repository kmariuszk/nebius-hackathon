import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { Editor } from 'tldraw'
import { DEFAULT_TOUR_TITLE } from '../../shared/acpExt.ts'
import { paperShapeId } from '../../shared/ids.ts'
import type { PaperCardProps } from '../../shared/paperCard.ts'
import { defaultPaperCardProps } from '../../shared/shapes.ts'
import { currentGoal, openPaperId, paperMoreOpen, tour, type Tour, type TourStep } from '../viewerState.ts'
import {
	boardSteps,
	runTour,
	stepsFromBoard,
	stepsOnBoard,
	tourOnGone,
	tourOnOpen,
	tourOnVote,
	tourReducer,
	visibleCard,
} from './tour.ts'

const steps = (...ids: string[]): TourStep[] => ids.map((paperId) => ({ paperId, line: `Why ${paperId}` }))
const start = (...ids: string[]) => tourReducer(null, { type: 'start', steps: steps(...ids), title: DEFAULT_TOUR_TITLE })!
const at = (t: Tour | null) => (t ? `${t.steps[t.i].paperId} (${t.i + 1} of ${t.steps.length})` : null)

afterEach(() => {
	tour.set(null)
	openPaperId.set(null)
	paperMoreOpen.set(false)
	currentGoal.set('new-findings')
})

/* ---------- the reducer ---------- */

test('start opens the first step; with nothing to show there is no tour', () => {
	const t = start('a', 'b', 'c')
	assert.deepEqual(t, { title: 'Catch-up', steps: steps('a', 'b', 'c'), i: 0 })
	assert.equal(tourReducer(null, { type: 'start', steps: [], title: DEFAULT_TOUR_TITLE }), null)
	// starting again starts over
	assert.equal(at(tourReducer({ ...t, i: 2 }, { type: 'start', steps: steps('d', 'e'), title: 'New this week' })), 'd (1 of 2)')
})

test('Next and Prev move between the steps and stop at the ends', () => {
	const t = start('a', 'b', 'c')
	assert.equal(tourReducer(t, { type: 'prev' }), t)
	const second = tourReducer(t, { type: 'next' })
	assert.equal(at(second), 'b (2 of 3)')
	const last = tourReducer(second, { type: 'next' })
	assert.equal(at(last), 'c (3 of 3)')
	// the last step's button is Done, which ends; Next (the arrow key) stays put
	assert.equal(tourReducer(last, { type: 'next' }), last)
	assert.equal(at(tourReducer(last, { type: 'prev' })), 'b (2 of 3)')
})

test('Keep opens the next paper and keeping the last one ends the tour; other votes change nothing', () => {
	const t = start('a', 'b', 'c')
	const second = tourReducer(t, { type: 'voted', paperId: 'a', decision: 'keep' })
	assert.equal(at(second), 'b (2 of 3)')
	// the kept paper stays a step, so Prev goes back to it
	assert.equal(at(tourReducer(second, { type: 'prev' })), 'a (1 of 3)')
	assert.equal(tourReducer({ ...t, i: 2 }, { type: 'voted', paperId: 'c', decision: 'keep' }), null)
	// a vote on a paper the tour isn't on, or Bring it back, leaves it where it is
	assert.equal(tourReducer(t, { type: 'voted', paperId: 'b', decision: 'keep' }), t)
	assert.equal(tourReducer(t, { type: 'voted', paperId: 'x', decision: 'discard' }), t)
	assert.equal(tourReducer(t, { type: 'voted', paperId: 'a', decision: null }), t)
})

test('Discard takes the paper out of the steps and opens the next; on the last one the tour ends', () => {
	const t = start('a', 'b', 'c')
	assert.equal(at(tourReducer({ ...t, i: 1 }, { type: 'voted', paperId: 'b', decision: 'discard' })), 'c (2 of 2)')
	// another paper leaving keeps the open one
	assert.equal(at(tourReducer(t, { type: 'voted', paperId: 'b', decision: 'discard' })), 'a (1 of 2)')
	assert.equal(at(tourReducer({ ...t, i: 2 }, { type: 'voted', paperId: 'a', decision: 'discard' })), 'c (2 of 2)')
	assert.equal(tourReducer({ ...t, i: 2 }, { type: 'voted', paperId: 'c', decision: 'discard' }), null)
	assert.equal(tourReducer(start('a'), { type: 'voted', paperId: 'a', decision: 'discard' }), null)
})

test('the demo script: Keep on paper 1, Discard on paper 2, a vote on paper 3 ends the tour', () => {
	let t: Tour | null = start('p1', 'p2', 'p3')
	assert.equal(at(t), 'p1 (1 of 3)')
	t = tourReducer(t, { type: 'voted', paperId: 'p1', decision: 'keep' })
	assert.equal(at(t), 'p2 (2 of 3)')
	t = tourReducer(t, { type: 'voted', paperId: 'p2', decision: 'discard' })
	assert.equal(at(t), 'p3 (2 of 2)')
	assert.deepEqual(t!.steps, steps('p1', 'p3'))
	assert.equal(tourReducer(t, { type: 'voted', paperId: 'p3', decision: 'keep' }), null)
	assert.equal(tourReducer(t, { type: 'voted', paperId: 'p3', decision: 'discard' }), null)
})

test('a paper that leaves the board leaves the tour; End, and anything after it, leaves no tour', () => {
	const t = { ...start('a', 'b', 'c'), i: 2 }
	const after = tourReducer(t, { type: 'gone', paperId: 'a' })
	assert.equal(at(after), 'c (2 of 2)')
	assert.equal(tourReducer(after, { type: 'gone', paperId: 'c' }), null)
	assert.equal(tourReducer(t, { type: 'end' }), null)
	for (const action of [{ type: 'next' }, { type: 'prev' }, { type: 'end' }, { type: 'voted', paperId: 'a', decision: 'keep' }] as const) {
		assert.equal(tourReducer(null, action), null)
	}
})

/* ---------- where the steps come from ---------- */

const cards: Record<string, Pick<PaperCardProps, 'scores' | 'oneLine'>> = {
	scored: { scores: { 'new-findings': { score: 0.9, fit: 'high', why: 'Cites 3 of your seeds and sorts the clusters you asked about.' } }, oneLine: 'Isolates CD8+ T cells.' },
	read: { scores: {}, oneLine: 'Maps T cell states across 30 melanomas.' },
	bare: { scores: {}, oneLine: '' },
}
const lookup = (paperId: string) => cards[paperId]

test('Catch me up from the board: the fresh papers in ranking order, each with its why, else its one line', () => {
	const derived = { fresh: ['read', 'scored', 'off-board', 'bare'] }
	assert.deepEqual(stepsFromBoard(derived, 'new-findings', lookup), [
		{ paperId: 'read', line: 'Maps T cell states across 30 melanomas.' },
		{ paperId: 'scored', line: 'Cites 3 of your seeds and sorts the clusters you asked about.' },
		{ paperId: 'bare', line: 'New since your last visit' },
	])
	// the why belongs to the viewer's goal
	assert.equal(stepsFromBoard(derived, 'methods', lookup)[1].line, 'Isolates CD8+ T cells.')
})

test('an agent’s tour keeps its lines and drops papers not on the board, and repeats', () => {
	const agent = [
		{ paperId: 'scored', line: 'Start here: it cites three of your seeds.' },
		{ paperId: 'pmid:404', line: 'Not on the board.' },
		{ paperId: 'scored', line: 'Again.' },
		{ paperId: 'read', line: '  ' },
	]
	assert.deepEqual(stepsOnBoard(agent, 'new-findings', lookup), [
		{ paperId: 'scored', line: 'Start here: it cites three of your seeds.' },
		{ paperId: 'read', line: 'Maps T cell states across 30 melanomas.' },
	])
	assert.deepEqual(stepsOnBoard([{ paperId: 'pmid:404', line: 'x' }], 'new-findings', lookup), [])
})

// A board behind the few editor calls the tour reads: cards (some on another page, some hidden by the viewer's filters)
function board(papers: Record<string, Partial<PaperCardProps> & { page?: string; hidden?: boolean }>) {
	const shapes = new Map<string, { id: string; type: string; props: PaperCardProps; page: string; hidden: boolean }>()
	for (const [paperId, { page = 'page:1', hidden = false, ...props }] of Object.entries(papers)) {
		const id = paperShapeId(paperId)
		shapes.set(id, { id, type: 'paper-card', props: defaultPaperCardProps(paperId, props), page, hidden })
	}
	return {
		getCurrentPageId: () => 'page:1',
		getCurrentPageShapes: () => [...shapes.values()].filter((s) => s.page === 'page:1'),
		getShape: (id: string) => shapes.get(id),
		getAncestorPageId: (s: { page: string }) => s.page,
		isShapeHidden: (s: { hidden: boolean }) => s.hidden,
		getBindingsToShape: () => [],
		getBindingsFromShape: () => [],
	} as unknown as Editor
}

const fit = (score: number, why = ''): Partial<PaperCardProps> => ({ scores: { 'new-findings': { score, fit: 'high', why } } })

test('the board’s tour: new papers the viewer can see, best first; seeds, discarded and hidden papers stay out', () => {
	const editor = board({
		low: fit(0.2, 'A method you could reuse.'),
		top: fit(0.9, 'Cites 3 of your seeds.'),
		mid: { ...fit(0.6), oneLine: 'Maps T cell states.' },
		seen: { ...fit(0.95), status: 'kept', kind: 'kept' },
		gone: { ...fit(0.8), status: 'discarded' },
		filtered: { ...fit(0.7), hidden: true },
		elsewhere: { ...fit(0.99), page: 'page:2' },
		seed: { kind: 'seed', status: 'kept' },
	})
	assert.deepEqual(boardSteps(editor), [
		{ paperId: 'top', line: 'Cites 3 of your seeds.' },
		{ paperId: 'mid', line: 'Maps T cell states.' },
		{ paperId: 'low', line: 'A method you could reuse.' },
	])
	assert.equal(visibleCard(editor, 'filtered'), undefined)
	assert.equal(visibleCard(editor, 'elsewhere'), undefined)
	assert.equal(visibleCard(editor, 'pmid:404'), undefined)
	assert.equal(visibleCard(editor, 'top')?.paperId, 'top')
})

/* ---------- on this viewer ---------- */

test('running the tour opens each step’s paper with More closed, and the end closes the widgets', () => {
	paperMoreOpen.set(true)
	runTour({ type: 'start', steps: steps('p1', 'p2', 'p3'), title: DEFAULT_TOUR_TITLE })
	assert.equal(openPaperId.get(), 'p1')
	assert.equal(paperMoreOpen.get(), false)
	assert.equal(at(tour.get()), 'p1 (1 of 3)')

	runTour({ type: 'voted', paperId: 'p1', decision: 'keep' })
	assert.equal(openPaperId.get(), 'p2')
	runTour({ type: 'voted', paperId: 'p2', decision: 'discard' })
	assert.equal(openPaperId.get(), 'p3')
	paperMoreOpen.set(true)
	runTour({ type: 'prev' })
	assert.equal(openPaperId.get(), 'p1')
	assert.equal(paperMoreOpen.get(), false)
	runTour({ type: 'next' })
	runTour({ type: 'voted', paperId: 'p3', decision: 'keep' })
	assert.equal(tour.get(), null)
	assert.equal(openPaperId.get(), null)
})

test('with no tour running, ending or stepping leaves the open paper alone', () => {
	openPaperId.set('x')
	runTour({ type: 'end' })
	runTour({ type: 'next' })
	runTour({ type: 'start', steps: [], title: DEFAULT_TOUR_TITLE })
	assert.equal(openPaperId.get(), 'x')
	assert.equal(tour.get(), null)
	// × and Done end a running one, and close its paper
	runTour({ type: 'start', steps: steps('p1', 'p2'), title: DEFAULT_TOUR_TITLE })
	runTour({ type: 'end' })
	assert.equal(tour.get(), null)
	assert.equal(openPaperId.get(), null)
})

test('a vote moves the tour on and says whether it ended it; outside a tour, Discard closes the paper', () => {
	runTour({ type: 'start', steps: steps('p1', 'p2'), title: DEFAULT_TOUR_TITLE })
	assert.equal(tourOnVote('p2', 'keep'), false)
	assert.equal(tourOnVote('p1', 'keep'), false)
	assert.equal(openPaperId.get(), 'p2')
	runTour({ type: 'prev' })
	assert.equal(tourOnVote('p2', 'keep'), false)
	assert.equal(at(tour.get()), 'p1 (1 of 2)')
	runTour({ type: 'next' })
	assert.equal(tourOnVote('p2', 'keep'), true)
	assert.equal(tour.get(), null)
	assert.equal(openPaperId.get(), null)

	openPaperId.set('x')
	assert.equal(tourOnVote('x', 'keep'), false)
	assert.equal(openPaperId.get(), 'x')
	paperMoreOpen.set(true)
	assert.equal(tourOnVote('x', 'discard'), false)
	assert.equal(openPaperId.get(), null)
	assert.equal(paperMoreOpen.get(), false)
})

test('a step whose card is hidden or deleted is skipped, and after the last step the tour ends', () => {
	runTour({ type: 'start', steps: steps('p1', 'p2', 'p3'), title: DEFAULT_TOUR_TITLE })
	tourOnVote('p1', 'keep')
	assert.equal(openPaperId.get(), 'p2')
	tourOnGone('p2')
	assert.equal(at(tour.get()), 'p3 (2 of 2)')
	assert.equal(openPaperId.get(), 'p3')
	tourOnGone('p3')
	assert.equal(tour.get(), null)
	assert.equal(openPaperId.get(), null)

	openPaperId.set('x')
	tourOnGone('x')
	assert.equal(openPaperId.get(), null)
})

test('opening a paper the tour isn’t on, or closing, ends the tour; opening its own step doesn’t', () => {
	runTour({ type: 'start', steps: steps('p1', 'p2'), title: DEFAULT_TOUR_TITLE })
	tourOnOpen('p1')
	assert.equal(at(tour.get()), 'p1 (1 of 2)')
	tourOnOpen('x')
	assert.equal(tour.get(), null)
	runTour({ type: 'start', steps: steps('p1', 'p2'), title: DEFAULT_TOUR_TITLE })
	tourOnOpen(null)
	assert.equal(tour.get(), null)
})

test('a Discard mid-tour moves on, so its Undo must not reopen the paper: that would end the tour', () => {
	runTour({ type: 'start', steps: steps('p1', 'p2', 'p3'), title: DEFAULT_TOUR_TITLE })
	runTour({ type: 'next' })
	assert.equal(tourOnVote('p2', 'discard'), false)
	assert.equal(at(tour.get()), 'p3 (2 of 2)')
	tourOnOpen('p2')
	assert.equal(tour.get(), null)
})
