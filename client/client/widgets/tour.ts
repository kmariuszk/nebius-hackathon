import { transact, type Editor, type TLShapeId } from 'tldraw'
import { DEFAULT_TOUR_TITLE } from '../../shared/acpExt.ts'
import { paperShapeId } from '../../shared/ids.ts'
import type { PaperCardProps } from '../../shared/paperCard.ts'
import { boardDerived, type BoardDerived } from '../shapes/card.ts'
import { currentGoal, openPaperId, paperMoreOpen, tour, type Tour, type TourStep } from '../viewerState.ts'
import type { Vote } from './votes.ts'

// Catch me up (T06, decision D24): a tour of new papers that runs in this browser only, from the
// board's own data (the top bar's button, ?tour=1) or from the agent's `_canvas/tour`. Each step
// opens its paper's widgets (T10); the tour bar in the actions widget steps through them, and
// Keep or Discard moves on. Nothing here writes to the room, and stepping costs no model calls.

export type TourAction =
	| { type: 'start'; steps: TourStep[]; title: string }
	| { type: 'next' }
	| { type: 'prev' }
	| { type: 'voted'; paperId: string; decision: Vote }
	/** The paper left the board (deleted, or discarded and hidden): it leaves the steps, as a Discard does. */
	| { type: 'gone'; paperId: string }
	| { type: 'end' }

export function tourReducer(state: Tour | null, action: TourAction): Tour | null {
	if (action.type === 'start') return action.steps.length ? { title: action.title, steps: action.steps, i: 0 } : null
	if (!state || action.type === 'end') return null
	const last = state.steps.length - 1
	switch (action.type) {
		case 'next':
			return state.i < last ? { ...state, i: state.i + 1 } : state
		case 'prev':
			return state.i > 0 ? { ...state, i: state.i - 1 } : state
		case 'voted':
			if (action.decision === 'discard') return drop(state, action.paperId)
			// Keep moves on, and keeping the last paper ends the tour; Bring it back changes nothing
			if (action.decision !== 'keep' || state.steps[state.i].paperId !== action.paperId) return state
			return state.i < last ? { ...state, i: state.i + 1 } : null
		case 'gone':
			return drop(state, action.paperId)
	}
}

/** The paper leaves the steps and the one after it opens; after the last one the tour ends. */
function drop(state: Tour, paperId: string): Tour | null {
	const k = state.steps.findIndex((s) => s.paperId === paperId)
	if (k < 0) return state
	const steps = state.steps.filter((_, j) => j !== k)
	if (!steps.length || (k === state.i && k === steps.length)) return null
	return { ...state, steps, i: k < state.i ? state.i - 1 : state.i }
}

type LineCard = Pick<PaperCardProps, 'scores' | 'oneLine'>

/** A paper's line in the tour bar: why it ranks where it does for this goal, else its one line. */
export const lineFor = (card: LineCard, goal: string) => card.scores[goal]?.why || card.oneLine || 'New since your last visit'

/**
 * The agent's steps (`_canvas/tour`) that can open here: papers not on the board (`card` gives
 * nothing) and repeats are dropped, and a blank line gets the card's own.
 */
export function stepsOnBoard(steps: TourStep[], goal: string, card: (paperId: string) => LineCard | undefined): TourStep[] {
	const seen = new Set<string>()
	return steps.flatMap((step) => {
		const c = card(step.paperId)
		if (!c || seen.has(step.paperId)) return []
		seen.add(step.paperId)
		return [{ paperId: step.paperId, line: step.line.trim() || lineFor(c, goal) }]
	})
}

/** Catch me up from the board: its new papers, in this viewer's ranking order (`boardDerived().fresh`). */
export function stepsFromBoard(
	derived: Pick<BoardDerived, 'fresh'>,
	goal: string,
	card: (paperId: string) => LineCard | undefined
): TourStep[] {
	return stepsOnBoard(derived.fresh.map((paperId) => ({ paperId, line: '' })), goal, card)
}

/** A paper's props if its card is on this page and shown, so that a step can open it. */
export function visibleCard(editor: Editor, paperId: string): PaperCardProps | undefined {
	const s = editor.getShape(paperShapeId(paperId) as TLShapeId)
	if (s?.type !== 'paper-card' || editor.getAncestorPageId(s) !== editor.getCurrentPageId() || editor.isShapeHidden(s)) return undefined
	return s.props
}

/** The steps Catch me up would walk through on this board now. */
export const boardSteps = (editor: Editor) => stepsFromBoard(boardDerived(editor), currentGoal.get(), (paperId) => visibleCard(editor, paperId))

/** The top bar's Catch me up, and ?tour=1. */
export const startCatchUp = (editor: Editor) => runTour({ type: 'start', steps: boardSteps(editor), title: DEFAULT_TOUR_TITLE })

/**
 * Moves this viewer's tour and opens the paper it's on (each opens with More closed). Ending closes
 * the widgets, and PaperWidgets flies the camera back to where it was before the tour. Returns
 * whether this ended a running tour.
 */
export function runTour(action: TourAction): boolean {
	const was = tour.get()
	const next = tourReducer(was, action)
	if (next === was) return false
	transact(() => {
		tour.set(next)
		paperMoreOpen.set(false)
		if (next) openPaperId.set(next.steps[next.i].paperId)
		else openPaperId.set(null)
	})
	return next === null && was !== null
}

/** The paper the tour is on, if one is running. */
export const tourPaperId = (t: Tour | null) => (t ? t.steps[t.i].paperId : null)

/** Closes the open paper's widgets. */
export const closePaper = () => {
	openPaperId.set(null)
	paperMoreOpen.set(false)
}

/**
 * After a saved vote the tour moves on; outside it, Discard closes the paper if it's still open.
 * Returns whether the vote ended the tour.
 */
export function tourOnVote(paperId: string, decision: Vote): boolean {
	if (tour.get()) return runTour({ type: 'voted', paperId, decision })
	if (decision === 'discard' && openPaperId.get() === paperId) closePaper()
	return false
}

/** A paper that left the board closes, or during the tour leaves it. */
export function tourOnGone(paperId: string) {
	if (tour.get()?.steps.some((s) => s.paperId === paperId)) runTour({ type: 'gone', paperId })
	else closePaper()
}

/** Opening a paper the tour isn't on, or closing (`paperId` null), ends the tour. */
export function tourOnOpen(paperId: string | null) {
	const t = tour.get()
	if (t && tourPaperId(t) !== paperId) tour.set(null)
}
