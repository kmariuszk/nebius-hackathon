import type { PaperKind, PaperStatus } from '../shared/paperCard.ts'
import type { PaperCardShape } from '../shared/shapes.ts'
import { findCard, hasVotes, inTransaction, setDecision, upsertPaper, votesFor, type Decision, type Votes } from './boardDb.ts'
import { addEvent } from './events.ts'
import { HttpError, writeRoom, writer } from './rooms.ts'

// Collaborative triage (Concept, T08): people's Keep and Discard votes and the card status they
// give. The board DB holds the votes; the card's status, kind, keepBy and discardBy follow them,
// written by the board service only (the agent has no vote tool).

/**
 * Any Keep and no Discard: kept. Only Discards: discarded. Both: contested. No votes: new, or kept
 * for a seed (seeds are in the collection already). Kind follows: kept or suggestion; seeds stay seeds.
 */
export function triage(kind: PaperKind, { keepBy, discardBy }: Votes): { status: PaperStatus; kind: PaperKind } {
	const status: PaperStatus =
		keepBy.length && discardBy.length
			? 'contested'
			: keepBy.length
				? 'kept'
				: discardBy.length
					? 'discarded'
					: kind === 'seed'
						? 'kept'
						: 'new'
	return { status, kind: kind === 'seed' ? 'seed' : status === 'kept' ? 'kept' : 'suggestion' }
}

export interface VoteResult extends Votes {
	status: PaperStatus
}

/**
 * Records the member's decision (null takes it back) and updates the card for everyone, in one room
 * transaction inside one board DB transaction: if the card can't be written, the vote isn't either.
 */
export function castVote(boardId: string, paperId: string, memberId: string, decision: Decision | null): VoteResult {
	let changed = false
	const result = inTransaction(() =>
		writeRoom(boardId, (txn) => {
			const card = findCard(txn, paperId)
			if (!card) throw new HttpError(404, `No card for ${paperId} on this board`)
			// votes cast on the card before the board DB knew the paper (the demo seed, older rooms)
			if (!hasVotes(boardId, paperId)) {
				for (const m of card.props.keepBy) setDecision(boardId, paperId, m, 'keep')
				for (const m of card.props.discardBy) setDecision(boardId, paperId, m, 'discard')
			}
			changed = setDecision(boardId, paperId, memberId, decision) !== decision
			const votes = votesFor(boardId, paperId)
			const { status, kind } = triage(card.props.kind, votes)
			const next = writer(txn).patchShape({ id: card.id, props: { status, kind, ...votes } }) as PaperCardShape
			upsertPaper(boardId, next)
			return { status, ...votes }
		})
	)
	if (changed) addEvent({ boardId, actor: memberId, type: 'paper.voted', payload: { paperId, decision, ...result } })
	return result
}
