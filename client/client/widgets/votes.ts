import type { Editor, TLShapeId } from 'tldraw'
import type { PaperCardProps, PaperStatus } from '../../shared/paperCard.ts'

// Keep and Discard, written straight to the card through the editor so every browser sees them.
// Stand-in until the board service's vote API (T08) owns keepBy and discardBy; the board model's
// side effects don't count these fields as a person editing the card.

export type Vote = 'keep' | 'discard' | null
export type VoteFields = Pick<PaperCardProps, 'keepBy' | 'discardBy' | 'status' | 'kind'>

export function myVote(props: Pick<PaperCardProps, 'keepBy' | 'discardBy'>, memberId: string): Vote {
	if (props.keepBy.includes(memberId)) return 'keep'
	if (props.discardBy.includes(memberId)) return 'discard'
	return null
}

export function statusOf(keepBy: string[], discardBy: string[]): PaperStatus {
	if (keepBy.length && discardBy.length) return 'contested'
	if (keepBy.length) return 'kept'
	if (discardBy.length) return 'discarded'
	return 'new'
}

/** The card's vote fields after `memberId` votes (null takes their vote back). */
export function applyVote(props: VoteFields, memberId: string, vote: Vote): VoteFields {
	const keepBy = props.keepBy.filter((m) => m !== memberId)
	const discardBy = props.discardBy.filter((m) => m !== memberId)
	if (vote === 'keep') keepBy.push(memberId)
	if (vote === 'discard') discardBy.push(memberId)
	const status = statusOf(keepBy, discardBy)
	// a kept suggestion joins the collection; seeds stay seeds
	const kind = props.kind === 'seed' ? 'seed' : status === 'kept' ? 'kept' : 'suggestion'
	return { keepBy, discardBy, status, kind }
}

/** Writes the vote and returns this member's previous vote, for Undo. */
export function castVote(editor: Editor, shapeId: TLShapeId, memberId: string, vote: Vote): Vote | undefined {
	const shape = editor.getShape(shapeId)
	if (shape?.type !== 'paper-card') return undefined
	const before = myVote(shape.props, memberId)
	editor.updateShape({ id: shapeId, type: 'paper-card', props: applyVote(shape.props, memberId, vote) })
	return before
}
