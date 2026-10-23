import type { PaperType } from './paperCard.ts'
import type { PaperCardShape } from './shapes.ts'

// How papers read on the board, shared by the node, the widgets and the ranked list.

const PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'del', 'della', 'da', 'di', 'du', 'la', 'le', 'dos', 'das'])

/** "Ana Ibáñez-Molero" → "Ibáñez-Molero"; "Jan van der Berg" → "van der Berg". */
export function familyName(author: string): string {
	const words = author.trim().split(/\s+/)
	let start = words.length - 1
	while (start > 1 && PARTICLES.has(words[start - 1].toLowerCase())) start--
	return words.slice(start).join(' ')
}

/** The label under a node: first author's family name and the year, "Ibáñez-Molero 2026". */
export function nodeLabel(authors: string[], year: number | null): string {
	const name = authors[0] ? familyName(authors[0]) : ''
	return [name, year ?? ''].join(' ').trim() || 'Unknown'
}

export const cardLabel = (card: PaperCardShape) => nodeLabel(card.props.authors, card.props.year)

/** The byline's authors: "Tirosh", "Tirosh and Izar", "Tirosh et al.". */
export function shortAuthors(authors: string[]): string {
	const names = authors.filter((a) => a && a !== 'et al.').map(familyName)
	if (names.length <= 1) return names[0] ?? ''
	if (names.length === 2 && authors.length === 2) return `${names[0]} and ${names[1]}`
	return `${names[0]} et al.`
}

/** Some bioRxiv records in PubMed are all capitals; show those in sentence case, leave the rest. */
export function sentenceCase(title: string): string {
	if (!/[A-Z]/.test(title) || title !== title.toUpperCase()) return title
	return title.charAt(0) + title.slice(1).toLowerCase()
}

/** Discovery emits article, review, preprint or OpenAlex's raw work type; anything else is other. */
export function normaliseType(raw: string | null | undefined): PaperType {
	const type = (raw ?? '').trim().toLowerCase()
	if (type === 'article' || type === 'journal-article') return 'article'
	if (type === 'review') return 'review'
	if (type === 'preprint' || type === 'posted-content') return 'preprint'
	return 'other'
}
