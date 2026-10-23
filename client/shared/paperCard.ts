import type { TLShape } from '@tldraw/tlschema'
import type { PaperCardShape } from './shapes.ts'

// The `paper-card` shape's props: the contract between the board model that validates them
// (T01, validators in shapes.ts), the canvas MCP that writes them (T02) and the v5 widgets that
// read them (T10). Changing a field here changes all three, plus a migration in shapes.ts.

export const PAPER_CARD_TYPE = 'paper-card'

export const isPaperCard = (shape: TLShape | undefined): shape is PaperCardShape => shape?.type === PAPER_CARD_TYPE

/** Normalised by `normaliseType` (display.ts) from whatever discovery emits; raw value in `typeRaw`. */
export type PaperType = 'article' | 'review' | 'preprint' | 'other'
export type PaperKind = 'seed' | 'kept' | 'suggestion'
export type PaperStatus = 'new' | 'kept' | 'contested' | 'discarded'
export type Fit = 'low' | 'medium' | 'high'
/** How a glance step compares with the board's seeds: "✓ Same", "＋ New" (`adds`), or neither. */
export type SeedRelation = 'same' | 'adds' | 'other'

/** One entry per "Looking for" goal, for example `new-findings` or `methods`. */
export interface GoalScore {
	score: number
	fit: Fit
	/** The ranked list's one line. */
	why: string
}

/** A real figure from the paper; never a generated image. */
export interface PaperFigure {
	imageUrl: string
	/** "Fig. 3" */
	label: string
	caption: string
	/** True when `caption` was written by the agent (shown with an "AI" tag), false for the paper's own. */
	captionByAi: boolean
}

/** Text quoted word for word from the paper; `url` carries a `#:~:text=` fragment. */
export interface PaperQuote {
	id: string
	text: string
	/** Where it came from, for example "abstract". */
	source: string
	verified: boolean
	url: string
}

/** A phrase of `oneLine` that gets underlined; hovering it shows its evidence. */
export interface PaperClaim {
	/** Appears verbatim in `oneLine`. */
	text: string
	/** Quote IDs on this card, or "seeds" for "three of your seeds" (lights the seeds up). */
	evidence: string[]
}

/** v5 "The paper at a glance": one of 3–4 steps (Samples, Method, Readout, Finding). */
export interface GlanceStep {
	label: string
	text: string
	/** The quote (abstract sentence) the step comes from, shown on hover. */
	quoteId: string | null
	/** Compared with the seeds; null for steps that take no mark (usually the Finding). */
	relation: SeedRelation | null
}

/** Which model wrote a card field and when (ms since epoch), for the "AI" labels. */
export interface FieldProvenance {
	model: string | null
	at: number
}

export interface PaperCardProps {
	w: number
	h: number

	// Identity
	paperId: string
	title: string
	/** Display names, first author first. */
	authors: string[]
	year: number | null
	venue: string
	url: string
	type: PaperType
	typeRaw: string
	/** False for preprints; null when unknown. */
	peerReviewed: boolean | null
	citedBy: number | null

	// Board state
	kind: PaperKind
	status: PaperStatus
	/** "Agent is reading…" */
	working: boolean
	/** Member IDs; written only by the board service from votes (T08). */
	keepBy: string[]
	discardBy: string[]

	/** Fit per "Looking for" goal; the node colour follows the viewer's current goal. */
	scores: Record<string, GoalScore>

	// The opened paper's widgets (v5)
	figure: PaperFigure | null
	/** "Why it matters to you": the summary written for the board's question. */
	oneLine: string
	claims: PaperClaim[]
	quotes: PaperQuote[]
	/** "The paper at a glance": empty until the agent has read the paper. */
	glance: GlanceStep[]

	// Under "More"
	summary: string
	/** What couldn't be checked. */
	gaps: string[]
	/** How the paper was found, as discovery reports it (for example "pubmed", "cites 3 seeds"). */
	foundBy: string[]

	/** Keyed by prop name, for each field the agent wrote with `set_card`. */
	provenance: Record<string, FieldProvenance>
}
