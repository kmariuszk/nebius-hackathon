import { computed, type Computed, type Editor, type TLShapeId } from 'tldraw'
import { CARD_SIZE, type PaperCardShape } from '../../shared/shapes.ts'
import { currentGoal } from '../viewerState.ts'

// The v6 card (docs/mockups/flashcard-v6.html): every paper is a 172×70 card, centred where the
// node's props.w × props.h box is, so the widgets keep working unchanged. The server's layout
// keeps the same CARD_SIZE clear around every node.

export const CARD_W = CARD_SIZE.w
export const CARD_H = CARD_SIZE.h

/** Where the card sits inside the shape's own space. */
export const cardOffset = (shape: PaperCardShape) => ({
	x: shape.props.w / 2 - CARD_W / 2,
	y: shape.props.h / 2 - CARD_H / 2,
})

/** Saved papers are pinned; suggestions are taped up. */
export const isSaved = (shape: PaperCardShape) => shape.props.kind !== 'suggestion'

export const FIT_LABEL = { high: 'High fit', medium: 'Medium fit', low: 'Low fit' } as const

export const GOALS: Record<string, { label: string; desc: string }> = {
	'new-findings': { label: 'New findings', desc: 'Papers that tell you more about your question.' },
	methods: { label: 'Methods to reuse', desc: 'Papers with techniques you could use in your own work.' },
}

const hash = (s: string) => {
	let h = 7
	for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0
	return Math.abs(h)
}
export const tilt = (id: string) => (((hash(id) % 9) / 8) * 2 - 1) * 1.8
export const seedOf = hash

// a hand-drawn marker loop: slightly wobbly, overshoots where it closes
export function loopPath(cx: number, cy: number, rx: number, ry: number, seed: number) {
	let v = seed % 2147483647 || 1
	const R = () => {
		v = (v * 16807) % 2147483647
		return (v - 1) / 2147483646
	}
	const p: [number, number][] = []
	const N = 22
	const a0 = -2.5
	for (let i = 0; i <= N; i++) {
		const t = a0 + ((Math.PI * 2 + 0.55) * i) / N
		const k = 1 + (i / N) * 0.07 + (R() - 0.5) * 0.035
		p.push([cx + Math.cos(t) * rx * k, cy + Math.sin(t) * ry * k])
	}
	let d = `M${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`
	for (let i = 0; i < p.length - 1; i++) {
		const p0 = p[i - 1] || p[i]
		const p1 = p[i]
		const p2 = p[i + 1]
		const p3 = p[i + 2] || p2
		d += ` C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)} ${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)} ${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`
	}
	return d
}

export interface BoardDerived {
	/** Suggestions in the agent's reading order for the viewer's goal: paperId → 1, 2, 3… */
	ranks: Map<string, number>
	/** The agent's red note under a new card. */
	notes: Map<string, string>
	/** New, not discarded papers in reading order, for Catch me up. */
	fresh: string[]
	/** The suggestions themselves, in reading order, for the ranked list. */
	ranked: PaperCardShape[]
}

const cache = new WeakMap<Editor, Computed<BoardDerived>>()

/** Ranks and agent notes, computed once per board change for every card. */
export function boardDerived(editor: Editor): BoardDerived {
	let c = cache.get(editor)
	if (!c) {
		c = computed('board derived', () => derive(editor))
		cache.set(editor, c)
	}
	return c.get()
}

function derive(editor: Editor): BoardDerived {
	const goal = currentGoal.get()
	const cards = editor
		.getCurrentPageShapes()
		.filter((s): s is PaperCardShape => s.type === 'paper-card' && s.props.status !== 'discarded')
	const score = (s: PaperCardShape) => s.props.scores[goal]?.score ?? -1
	const ranked = cards.filter((s) => !isSaved(s) && s.props.scores[goal]).sort((a, b) => score(b) - score(a))
	const ranks = new Map(ranked.map((s, i) => [s.props.paperId, i + 1]))
	const fresh = cards
		.filter((s) => s.props.status === 'new')
		.sort((a, b) => (ranks.get(a.props.paperId) ?? 1e9) - (ranks.get(b.props.paperId) ?? 1e9))
		.map((s) => s.props.paperId)

	const notes = new Map<string, string>()
	const top = ranked.find((s) => s.props.status === 'new')
	const note = top && seedNote(seedLinksOf(editor, top.id))
	if (top && note) notes.set(top.props.paperId, note)
	for (const s of cards) {
		if (s === top || s.props.status !== 'new' || isSaved(s)) continue
		if (s.props.type === 'preprint' || s.props.peerReviewed === false) notes.set(s.props.paperId, 'preprint, not peer reviewed')
		else if (s.props.type === 'review') notes.set(s.props.paperId, 'a review: background reading')
	}
	return { ranks, notes, fresh, ranked }
}

/**
 * Seeds this card cites (it starts a `cites` arrow that ends on the seed) and seeds a `similar`
 * link joins it to. Other arrows, a seed citing this card among them, don't count.
 */
export function seedLinksOf(editor: Editor, cardId: TLShapeId) {
	const cites = new Set<string>()
	const close = new Set<string>()
	for (const b of editor.getBindingsToShape(cardId, 'arrow')) {
		const kind = editor.getShape(b.fromId)?.meta.kind
		for (const other of editor.getBindingsFromShape(b.fromId, 'arrow')) {
			if (other.toId === cardId) continue
			const s = editor.getShape(other.toId)
			if (s?.type !== 'paper-card' || s.props.kind !== 'seed') continue
			if (kind === 'cites' && b.props.terminal === 'start') cites.add(s.id)
			else if (kind === 'similar') close.add(s.id)
		}
	}
	return { cites: cites.size, close: close.size }
}

/** The agent's red note under the top new card: a citation says more than similarity. */
export function seedNote({ cites, close }: { cites: number; close: number }): string | null {
	if (cites) return `cites ${cites} of your seeds`
	return close ? `close to ${close} of your seeds` : null
}
