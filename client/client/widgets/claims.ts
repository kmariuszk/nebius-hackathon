import type { PaperClaim, PaperQuote } from '../../shared/paperCard.ts'

// "Why it matters to you": `oneLine` split into plain text and the claims to underline, each
// with the evidence its hover shows.

/** The evidence ID that points at the board's seeds instead of a quote. */
export const SEEDS_EVIDENCE = 'seeds'

export interface ClaimEvidence {
	/** Index into `props.claims`. */
	index: number
	quotes: PaperQuote[]
	/** Evidence IDs that match no quote on the card; shown with ⚠. */
	unknown: string[]
	/** "three of your seeds": hovering lights the seeds up instead of showing a quote. */
	seeds: boolean
	/** Backed by evidence, every quote found word for word, nothing unknown. */
	verified: boolean
}

export interface Segment {
	text: string
	claim: ClaimEvidence | null
}

export function claimEvidence(claim: PaperClaim, index: number, quotes: PaperQuote[]): ClaimEvidence {
	const found: PaperQuote[] = []
	const unknown: string[] = []
	let seeds = false
	for (const id of claim.evidence) {
		if (id === SEEDS_EVIDENCE) seeds = true
		else {
			const quote = quotes.find((q) => q.id === id)
			if (quote) found.push(quote)
			else unknown.push(id)
		}
	}
	const verified = unknown.length === 0 && found.every((q) => q.verified) && (found.length > 0 || seeds)
	return { index, quotes: found, unknown, seeds, verified }
}

/** Where `text` sits in `line`: exactly, or ignoring case when the model changed it. */
function occurrences(line: string, text: string): number[] {
	if (!text) return []
	const lower = line.toLowerCase()
	const exact = all(line, text)
	if (exact.length || lower.length !== line.length) return exact
	return all(lower, text.toLowerCase())
}

function all(haystack: string, needle: string): number[] {
	const out: number[] = []
	for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) out.push(i)
	return out
}

/**
 * Splits `oneLine` by its claims. Overlapping claims can't both be underlined: the earlier one
 * wins, and the longer one on a tie. Claims whose text isn't in `oneLine` come back in `unplaced`.
 */
export function splitClaims(oneLine: string, claims: PaperClaim[], quotes: PaperQuote[]) {
	const candidates = claims.flatMap((claim, index) =>
		occurrences(oneLine, claim.text).map((start) => ({ index, start, end: start + claim.text.length }))
	)
	candidates.sort((a, b) => a.start - b.start || b.end - a.end)
	const taken: typeof candidates = []
	const used = new Set<number>()
	for (const c of candidates) {
		if (used.has(c.index) || taken.some((t) => c.start < t.end && t.start < c.end)) continue
		taken.push(c)
		used.add(c.index)
	}
	taken.sort((a, b) => a.start - b.start)

	const segments: Segment[] = []
	let at = 0
	for (const t of taken) {
		if (t.start > at) segments.push({ text: oneLine.slice(at, t.start), claim: null })
		segments.push({ text: oneLine.slice(t.start, t.end), claim: claimEvidence(claims[t.index], t.index, quotes) })
		at = t.end
	}
	if (at < oneLine.length) segments.push({ text: oneLine.slice(at), claim: null })
	const unplaced = claims.map((_, i) => i).filter((i) => !used.has(i))
	return { segments, unplaced }
}

/** The link text for a quote's source: "PubMed" for PubMed links, else the site's name. */
export function sourceLabel(url: string): string {
	try {
		const host = new URL(url).hostname.replace(/^www\./, '')
		if (host.endsWith('pubmed.ncbi.nlm.nih.gov')) return 'PubMed'
		if (host.endsWith('ncbi.nlm.nih.gov')) return 'PubMed Central'
		return host
	} catch {
		return 'Source'
	}
}
