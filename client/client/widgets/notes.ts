import { CARD_SIZE } from '../../shared/shapes.ts'

// Team notes: built-in notes pinned to a paper with a `note-pin` binding (T01).

/** The text of a note's rich text (tiptap JSON): paragraphs and list items on their own lines. */
export function plainText(node: unknown): string {
	if (!node || typeof node !== 'object') return ''
	const n = node as { type?: string; text?: unknown; content?: unknown }
	if (typeof n.text === 'string') return n.text
	if (n.type === 'hardBreak') return '\n'
	const children = Array.isArray(n.content) ? n.content.map(plainText) : []
	const inline = n.type === 'paragraph' || n.type === 'heading'
	return children.join(inline ? '' : '\n').trim()
}

/** Who wrote a note, when we can tell: you, or the agent. */
export function noteAuthor(meta: Record<string, unknown> | undefined, memberId: string): string | null {
	if (meta?.author === memberId) return 'You'
	if (meta?.createdBy === 'agent') return 'Agent'
	return null
}

/** Size of the notes the widget creates: the board's notes are 200 px at scale 1. */
export const NOTE_SCALE = 0.8

/**
 * Where a pinned note goes, as the binding's offset from the node's top-left: 20 px right of the
 * card, a little below its middle (as the v6 board and seedDemo.ts pin them), each further note
 * on the same paper a step lower.
 */
export function pinOffset(node: { w: number; h: number }, pinnedAlready: number) {
	return { dx: node.w / 2 + CARD_SIZE.w / 2 + 20, dy: node.h / 2 + 12 + pinnedAlready * 34 }
}
