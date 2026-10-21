import { atom } from 'tldraw'

// Per-viewer state (decision D19): tldraw atoms that live in this browser only and are never
// written to the room, so two people can look at the same board differently.

/** The "Looking for" goal the nodes are coloured and ranked by. */
export const currentGoal = atom<string>('currentGoal', 'new-findings')

export interface BoardFilters {
	fit: ('low' | 'medium' | 'high')[]
	types: ('article' | 'review' | 'preprint' | 'other')[]
	peerReviewedOnly: boolean
	minCitedBy: number
	yearFrom: number | null
	showDiscarded: boolean
}

export const filters = atom<BoardFilters>('filters', {
	fit: ['low', 'medium', 'high'],
	types: ['article', 'review', 'preprint', 'other'],
	peerReviewedOnly: false,
	minCitedBy: 0,
	yearFrom: null,
	showDiscarded: false,
})

/** The paper whose widgets are open around its node (T10), or null. */
export const openPaperId = atom<string | null>('openPaperId', null)

/** Whether the open paper shows "More" (what supports it, and the rest); clicking its node again toggles it. */
export const paperMoreOpen = atom<boolean>('paperMoreOpen', false)

/** Papers lit up on this screen only: hovering "three of your seeds", or `_canvas/highlight` (T06). */
export const litPaperIds = atom<string[]>('litPaperIds', [])

export interface TourStep {
	paperId: string
	/** Shown in the tour bar under the paper's node. */
	line: string
}

export interface Tour {
	title: string
	steps: TourStep[]
	/** The step whose paper is open. */
	i: number
}

/** The Catch-me-up tour running in this browser (T06, decision D24), or null; widgets/tour.ts moves it. */
export const tour = atom<Tour | null>('tour', null)
