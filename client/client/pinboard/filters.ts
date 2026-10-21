import type { PaperCardProps } from '../../shared/paperCard.ts'
import type { BoardFilters } from '../viewerState.ts'

// This viewer's filters (T09): what passes makes the ranked list, the red rank numbers and Catch
// me up (shapes/card.ts); what doesn't fades on this board only. Seeds and kept papers are the
// collection, not suggestions, so they always pass.

export type Fit = BoardFilters['fit'][number]
export type FilterType = BoardFilters['types'][number]

export const FITS: readonly Fit[] = ['high', 'medium', 'low']
const TYPES: readonly FilterType[] = ['article', 'review', 'preprint', 'other']

export interface TypeChip {
	label: string
	types: readonly FilterType[]
}

/** The type chips; `other` (an OpenAlex book chapter, say) goes with articles. */
export const TYPE_CHIPS: readonly TypeChip[] = [
	{ label: 'Article', types: ['article', 'other'] },
	{ label: 'Review', types: ['review'] },
	{ label: 'Preprint', types: ['preprint'] },
]

/** "Cited at least" 10× or 50×. */
export const CITED_AT_LEAST = [10, 50] as const

/** "Since …" chips, as on the demo board in 2026: since 2023, since 2025. */
export const sinceYears = (thisYear: number) => [thisYear - 3, thisYear - 1]

/** Nothing filtered out; the `filters` atom starts here and Clear comes back here. */
export const DEFAULT_FILTERS: BoardFilters = {
	fit: ['low', 'medium', 'high'],
	types: ['article', 'review', 'preprint', 'other'],
	peerReviewedOnly: false,
	minCitedBy: 0,
	yearFrom: null,
	showDiscarded: false,
}

export type FilterCard = Pick<PaperCardProps, 'kind' | 'status' | 'type' | 'peerReviewed' | 'citedBy' | 'year' | 'scores'>

const narrowed = <T>(list: readonly T[], all: readonly T[]) => all.some((v) => !list.includes(v))

/**
 * Whether a card passes the filters for this goal. A filter that asks for something a paper
 * doesn't say fails it: no score for the goal is no fit, no `citedBy` is uncited, no year is
 * before any year. "Peer reviewed only" hides preprints and `peerReviewed: false`; unknown stays.
 */
export function passes(card: FilterCard, f: BoardFilters, goal: string): boolean {
	if (card.kind !== 'suggestion') return true
	if (card.status === 'discarded' && !f.showDiscarded) return false
	const fit = card.scores[goal]?.fit
	if (fit ? !f.fit.includes(fit) : narrowed(f.fit, FITS)) return false
	if (!f.types.includes(card.type)) return false
	if (f.peerReviewedOnly && (card.type === 'preprint' || card.peerReviewed === false)) return false
	if ((card.citedBy ?? 0) < f.minCitedBy) return false
	if (f.yearFrom != null && (card.year ?? -Infinity) < f.yearFrom) return false
	return true
}

/** How many filters are on, for the Filter button; showing discarded papers counts as one. */
export function activeCount(f: BoardFilters): number {
	return [
		narrowed(f.fit, FITS),
		narrowed(f.types, TYPES),
		f.peerReviewedOnly,
		f.minCitedBy > 0,
		f.yearFrom != null,
		f.showDiscarded,
	].filter(Boolean).length
}

/** A multi-select after clicking a chip: its values all off if they were all on, else all on. */
export function toggled<T>(list: readonly T[], values: readonly T[]): T[] {
	if (values.every((v) => list.includes(v))) return list.filter((v) => !values.includes(v))
	return [...list, ...values.filter((v) => !list.includes(v))]
}

export interface FilterOptions<C extends FilterCard> {
	/** Fit chips some suggestion has for the goal. */
	fits: Fit[]
	types: TypeChip[]
	/** "Peer reviewed only": some suggestion is a preprint or says whether it was peer reviewed. */
	peerReviewed: boolean
	/** "Cited at least": some suggestion has a citation count. */
	citedBy: boolean
	/** "Since …" years some suggestion was published in or after. */
	years: number[]
	/** Discarded papers on the board, for "Show discarded papers (N)". */
	discarded: number
	showDiscarded: boolean
	/** The suggestion that fits the goal best, for the note under "Cited at least". */
	best: C | null
}

/**
 * What the Filter panel offers: options whose data no suggestion has are left out rather than
 * shown empty, except one the viewer has set, so that it can be undone.
 */
export function filterOptions<C extends FilterCard>(cards: C[], f: BoardFilters, goal: string, thisYear: number): FilterOptions<C> {
	const pool = cards.filter((c) => c.kind === 'suggestion' && (c.status !== 'discarded' || f.showDiscarded))
	const discarded = cards.filter((c) => c.status === 'discarded').length
	let best: C | null = null
	for (const c of pool) {
		const score = c.scores[goal]?.score
		if (score != null && (!best || score > best.scores[goal].score)) best = c
	}
	return {
		fits: FITS.filter((k) => !f.fit.includes(k) || pool.some((c) => c.scores[goal]?.fit === k)),
		types: TYPE_CHIPS.filter((chip) => narrowed(f.types, chip.types) || pool.some((c) => chip.types.includes(c.type))),
		peerReviewed: f.peerReviewedOnly || pool.some((c) => c.type === 'preprint' || c.peerReviewed !== null),
		citedBy: f.minCitedBy > 0 || pool.some((c) => c.citedBy != null),
		years: sinceYears(thisYear).filter((y) => f.yearFrom === y || pool.some((c) => (c.year ?? -Infinity) >= y)),
		discarded,
		showDiscarded: f.showDiscarded || discarded > 0,
		best,
	}
}
