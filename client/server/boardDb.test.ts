// The board DB on a temp data dir: node --test server/boardDb.test.ts
import type { TLShapeId } from '@tldraw/tlschema'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'
import { paperShapeId } from '../shared/ids.ts'
import { defaultPaperCardProps } from '../shared/shapes.ts'
import {
	addRemovedLink,
	boardDb,
	boardInfo,
	boardsOf,
	closeBoardDb,
	createBoard,
	DEFAULT_GOALS,
	discardedIds,
	ensureBoard,
	findBoard,
	joinMember,
	markSeen,
	membersOf,
	papersOf,
	removedLinks,
	seedCount,
	setBoardDbPath,
	setDecision,
	syncPapers,
	touchRun,
	unvotedCount,
	updateBoard,
	votesFor,
} from './boardDb.ts'
import { closeAllRooms, patchShapes, putShapes, readRoom, setRoomsDir, writeRoom, type ShapePatch } from './rooms.ts'

const dir = mkdtempSync(join(tmpdir(), 'board-db-'))
const dbFile = join(dir, 'board.db')
setRoomsDir(join(dir, 'rooms'))
setBoardDbPath(dbFile)
after(async () => {
	// let the storage's throttled tombstone pruning (1 s after a delete) run before its database closes
	await new Promise((resolve) => setTimeout(resolve, 1100))
	closeAllRooms()
	closeBoardDb()
	rmSync(dir, { recursive: true, force: true })
})

const agentMeta = (paperId: string) => ({ createdBy: 'agent', onBehalfOf: 'm_ana', runId: 'run_0123456789ab', paperId })
const card = (paperId: string, kind: 'seed' | 'kept' | 'suggestion' = 'suggestion', meta: object = agentMeta(paperId)) => ({
	id: paperShapeId(paperId),
	type: 'paper-card',
	x: 0,
	y: 0,
	props: defaultPaperCardProps(paperId, { title: paperId, kind }),
	meta,
})

test('migrates once, and keeps the data when it opens again', () => {
	ensureBoard('kept-room')
	closeBoardDb()
	const raw = new DatabaseSync(dbFile)
	assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1)
	raw.close()
	assert.ok(findBoard('kept-room'))
	assert.ok(boardDb().isOpen)
})

test('a room gets its board row the first time it is used, with the default goals', () => {
	assert.equal(findBoard('old-room'), null)
	const board = ensureBoard('old-room')
	assert.deepEqual({ ...board, createdAt: '' }, {
		id: 'old-room',
		title: '',
		question: '',
		context: '',
		goals: DEFAULT_GOALS,
		createdBy: null,
		createdAt: '',
	})
	assert.equal(ensureBoard('old-room').createdAt, board.createdAt)
	// board IDs go through safeId, like room files
	assert.equal(ensureBoard('odd room!').id, 'odd_room_')
})

test('create and update a board; members join once, rename, and never move their seen mark back', () => {
	const board = createBoard({ title: 'Melanoma', question: 'What predicts response?' }, 'm_ana')
	assert.match(board.id, /^b_[a-z0-9]{10}$/)
	assert.equal(board.createdBy, 'm_ana')
	const updated = updateBoard(board.id, { context: 'Our cohort', title: undefined })
	assert.equal(updated.title, 'Melanoma')
	assert.equal(updated.context, 'Our cohort')
	assert.deepEqual(findBoard(board.id), updated)

	assert.equal(joinMember(board.id, 'm_ben', 'Ben').joined, true)
	const again = joinMember(board.id, 'm_ben')
	assert.equal(again.joined, false)
	assert.equal(again.member.displayName, 'Ben')
	assert.equal(joinMember(board.id, 'm_ben', 'Benjamin').member.displayName, 'Benjamin')
	assert.deepEqual(membersOf(board.id).map((m) => m.memberId), ['m_ben'])
	markSeen(board.id, 'm_ben', 7)
	markSeen(board.id, 'm_ben', 3)
	assert.equal(membersOf(board.id)[0].lastSeenSeq, 7)

	assert.ok(boardsOf('m_ana').some((b) => b.id === board.id), 'the creator')
	assert.ok(boardsOf('m_ben').some((b) => b.id === board.id), 'a member')
	assert.ok(!boardsOf('m_eve').some((b) => b.id === board.id))
})

test('decisions: one per member, in voting order; only-discarded papers are the negative signal', () => {
	const b = 'votes'
	assert.equal(setDecision(b, 'pmid:1', 'm_ana', 'keep'), null)
	setDecision(b, 'pmid:1', 'm_ben', 'discard')
	setDecision(b, 'pmid:2', 'm_ben', 'discard')
	setDecision(b, 'pmid:3', 'm_ana', 'discard')
	assert.equal(setDecision(b, 'pmid:3', 'm_ana', 'keep'), 'discard')
	assert.deepEqual(votesFor(b, 'pmid:1'), { keepBy: ['m_ana'], discardBy: ['m_ben'] })
	assert.deepEqual(discardedIds(b), ['pmid:2'])
	assert.equal(setDecision(b, 'pmid:2', 'm_ben', null), 'discard')
	assert.deepEqual(discardedIds(b), [])
	assert.deepEqual(votesFor(b, 'pmid:2'), { keepBy: [], discardBy: [] })
})

test('board_papers follows the cards: added, updated, dropped when the card goes', () => {
	const b = 'mirror'
	putShapes(b, [card('pmid:1', 'seed'), card('pmid:2'), card('pmid:3', 'suggestion', { author: 'm_ben' })])
	syncPapers(b)
	const rows = papersOf(b)
	assert.deepEqual(rows.map((r) => [r.paperId, r.kind, r.addedBy]), [
		['pmid:1', 'seed', 'agent'],
		['pmid:2', 'suggestion', 'agent'],
		['pmid:3', 'suggestion', 'm_ben'],
	])
	assert.equal(rows[0].runId, 'run_0123456789ab')
	assert.equal(seedCount(b), 1)
	setDecision(b, 'pmid:2', 'm_ana', 'keep')
	assert.equal(unvotedCount(b, 'm_ana'), 1)
	assert.equal(unvotedCount(b, 'm_ben'), 2)

	const scores = { methods: { score: 0.8, fit: 'high' as const, why: 'Same assay' } }
	patchShapes(b, [{ id: paperShapeId('pmid:2') as TLShapeId, props: { status: 'kept', kind: 'kept', scores } } as ShapePatch])
	writeRoom(b, (txn) => txn.delete(paperShapeId('pmid:3') as TLShapeId))
	syncPapers(b)
	assert.deepEqual(papersOf(b).map((r) => r.paperId), ['pmid:1', 'pmid:2'])
	assert.deepEqual(papersOf(b)[1], { ...rows[1], kind: 'kept', status: 'kept', scores })
	assert.ok(readRoom(b, (txn) => txn.get(paperShapeId('pmid:1'))), 'syncing never writes to the room')
})

test('removed links are recorded once; boardInfo has the question, goal IDs, discards and removed links', () => {
	const b = 'info'
	updateBoard(b, { question: 'Which T cells respond?', goals: [{ id: 'methods', label: 'Methods to reuse' }] })
	assert.equal(addRemovedLink(b, { from: 'pmid:1', to: 'pmid:2', kind: 'cites' }, 'm_ana'), true)
	assert.equal(addRemovedLink(b, { from: 'pmid:1', to: 'pmid:2', kind: 'cites' }, 'm_ben'), false)
	setDecision(b, 'pmid:9', 'm_ana', 'discard')
	assert.deepEqual(removedLinks(b), [{ from: 'pmid:1', to: 'pmid:2', kind: 'cites' }])
	assert.deepEqual(boardInfo(b), {
		question: 'Which T cells respond?',
		goals: ['methods'],
		discardedIds: ['pmid:9'],
		removedLinks: [{ from: 'pmid:1', to: 'pmid:2', kind: 'cites' }],
	})
	assert.deepEqual(boardInfo('never-used').goals, ['new-findings', 'methods'])
})

test('runs count their canvas writes', () => {
	touchRun('runs', 'run_00112233aabb', 'm_ana')
	touchRun('runs', 'run_00112233aabb', 'm_ana')
	const row = boardDb().prepare('SELECT * FROM runs WHERE id = ?').get('run_00112233aabb') as Record<string, unknown>
	assert.equal(row.events, 2)
	assert.equal(row.requested_by, 'm_ana')
	assert.equal(row.board_id, 'runs')
})
