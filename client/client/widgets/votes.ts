import type { PaperCardProps } from '../../shared/paperCard.ts'
import { boardApi } from '../api.ts'

// Keep and Discard go to the board service's vote route (T08), which records the vote and writes
// the card's status, kind, keepBy and discardBy for everyone through the sync room; the rules are
// in server/triage.ts. The browser never writes those fields itself.

export type Vote = 'keep' | 'discard' | null

export function myVote(props: Pick<PaperCardProps, 'keepBy' | 'discardBy'>, memberId: string): Vote {
	if (props.keepBy.includes(memberId)) return 'keep'
	if (props.discardBy.includes(memberId)) return 'discard'
	return null
}

/** Sends the vote and returns this member's previous one, for Undo. Throws an ApiError if it wasn't saved. */
export async function castVote(
	boardId: string,
	props: Pick<PaperCardProps, 'paperId' | 'keepBy' | 'discardBy'>,
	memberId: string,
	vote: Vote
): Promise<Vote> {
	const before = myVote(props, memberId)
	await boardApi(boardId, memberId).vote(props.paperId, vote)
	return before
}
