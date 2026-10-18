// Vote rules, and a vote's way into the board DB and onto the card in a real room: node --test server/triage.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { paperShapeId } from '../shared/ids.ts'
import type { PaperCardProps } from '../shared/paperCard.ts'
import { defaultPaperCardProps, type PaperCardShape } from '../shared/shapes.ts'
import { closeBoardDb, discardedIds, findPaper, setBoardDbPath, votesFor } from './boardDb.ts'
import { latestEvents } from './events.ts'
import { closeAllRooms, HttpError, putShapes, readRoom, setRoomsDir } from './rooms.ts'
import { castVote, triage } from './triage.ts'

const dir = mkdtempSync(join(tmpdir(), 'triage-'))
setRoomsDir(join(dir, 'rooms'))
setBoardDbPath(join(dir, 'board.db'))
after(() => {
	closeAllRooms()
	closeBoardDb()
	rmSync(dir, { recursive: true, force: true })
})

const votes = (keepBy: string[], discardBy: string[]) => ({ keepBy, discardBy })

test('the status rules: any Keep is kept, only Discards is discarded, both is contested', () => {
	assert.deepEqual(triage('suggestion', votes([], [])), { status: 'new', kind: 'suggestion' })
	assert.deepEqual(triage('suggestion', votes(['m_ana'], [])), { status: 'kept', kind: 'kept' })
	assert.deepEqual(triage('suggestion', votes(['m_ana', 'm_ben'], [])), { status: 'kept', kind: 'kept' })
	assert.deepEqual(triage('suggestion', votes([], ['m_ben'])), { status: 'discarded', kind: 'suggestion' })
	assert.deepEqual(triage('suggestion', votes(['m_ana'], ['m_ben'])), { status: 'contested', kind: 'suggestion' })
	// a kept paper that loses its Keeps goes back to the suggestions
	assert.deepEqual(triage('kept', votes([], ['m_ben'])), { status: 'discarded', kind: 'suggestion' })
	assert.deepEqual(triage('kept', votes([], [])), { status: 'new', kind: 'suggestion' })
	// seeds stay seeds, and are kept without votes
	assert.deepEqual(triage('seed', votes([], [])), { status: 'kept', kind: 'seed' })
	assert.deepEqual(triage('seed', votes([], ['m_ben'])), { status: 'discarded', kind: 'seed' })
	assert.deepEqual(triage('seed', votes(['m_ana'], ['m_ben'])), { status: 'contested', kind: 'seed' })
})

let boards = 0
function boardWith(paperId: string, props: Partial<PaperCardProps> = {}) {
	const boardId = `triage${++boards}`
	putShapes(boardId, [
		{
			id: paperShapeId(paperId),
			type: 'paper-card',
			x: 0,
			y: 0,
			props: defaultPaperCardProps(paperId, { title: 'Atlas', ...props }),
			meta: { createdBy: 'agent', onBehalfOf: 'm_ana', runId: null, paperId },
		},
	])
	return boardId
}
const card = (boardId: string, paperId: string) => readRoom(boardId, (txn) => txn.get(paperShapeId(paperId))) as PaperCardShape

test('Ana keeps, Ben discards, then each takes it back: the card follows for everyone', () => {
	const b = boardWith('pmid:1')
	assert.deepEqual(castVote(b, 'pmid:1', 'm_ana', 'keep'), { status: 'kept', keepBy: ['m_ana'], discardBy: [] })
	assert.equal(card(b, 'pmid:1').props.kind, 'kept')
	assert.deepEqual(castVote(b, 'pmid:1', 'm_ben', 'discard'), { status: 'contested', keepBy: ['m_ana'], discardBy: ['m_ben'] })
	const contested = card(b, 'pmid:1')
	assert.deepEqual([contested.props.status, contested.props.kind], ['contested', 'suggestion'])
	assert.deepEqual([contested.props.keepBy, contested.props.discardBy], [['m_ana'], ['m_ben']])
	assert.deepEqual(contested.meta, { createdBy: 'agent', onBehalfOf: 'm_ana', runId: null, paperId: 'pmid:1' }, 'not marked as edited')

	assert.equal(castVote(b, 'pmid:1', 'm_ana', null).status, 'discarded')
	assert.deepEqual(discardedIds(b), ['pmid:1'])
	assert.equal(findPaper(b, 'pmid:1')?.status, 'discarded')
	assert.deepEqual(castVote(b, 'pmid:1', 'm_ben', null), { status: 'new', keepBy: [], discardBy: [] })
	assert.equal(card(b, 'pmid:1').props.status, 'new')
	assert.deepEqual(discardedIds(b), [])
})

test('each vote that changes something is one paper.voted event; repeating a vote is a no-op', () => {
	const b = boardWith('pmid:2')
	castVote(b, 'pmid:2', 'm_ana', 'keep')
	castVote(b, 'pmid:2', 'm_ana', 'keep')
	castVote(b, 'pmid:2', 'm_ana', 'discard')
	const events = latestEvents(b, 0, 10)
	assert.deepEqual(events.map((e) => [e.type, e.actor, e.payload.decision, e.payload.status]), [
		['paper.voted', 'm_ana', 'discard', 'discarded'],
		['paper.voted', 'm_ana', 'keep', 'kept'],
	])
})

test('votes already on the card (the demo seed, older rooms) are kept when the first vote arrives', () => {
	const b = boardWith('pmid:3', { status: 'kept', kind: 'kept', keepBy: ['m_demoana000'] })
	assert.deepEqual(castVote(b, 'pmid:3', 'm_ben', 'discard'), {
		status: 'contested',
		keepBy: ['m_demoana000'],
		discardBy: ['m_ben'],
	})
	assert.deepEqual(votesFor(b, 'pmid:3'), { keepBy: ['m_demoana000'], discardBy: ['m_ben'] })
})

test('a vote on a seed keeps it a seed', () => {
	const b = boardWith('pmid:4', { kind: 'seed', status: 'kept' })
	assert.equal(castVote(b, 'pmid:4', 'm_ana', 'discard').status, 'discarded')
	assert.equal(card(b, 'pmid:4').props.kind, 'seed')
	assert.equal(castVote(b, 'pmid:4', 'm_ana', null).status, 'kept')
})

test('a vote on a paper with no card is refused and records nothing', () => {
	const b = boardWith('pmid:5')
	assert.throws(() => castVote(b, 'pmid:404', 'm_ana', 'keep'), (e: HttpError) => e.status === 404)
	assert.deepEqual(votesFor(b, 'pmid:404'), { keepBy: [], discardBy: [] })
	assert.deepEqual(latestEvents(b, 0, 10), [])
})
