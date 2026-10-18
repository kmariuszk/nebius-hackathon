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
 * Where a new note goes: just right of the card, a little higher than its centre, each further
 * note a step lower so they fan out (as in v5). Returns the pin offset from the card's top-left.
 */
export function newNoteOffset(card: { w: number; h: number }, pinned: number) {
	return { dx: card.w + 24, dy: card.h / 2 - 56 + pinned * 30 }
}
