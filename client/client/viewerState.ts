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
