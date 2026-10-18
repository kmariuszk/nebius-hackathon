import type { TLRecord } from '@tldraw/tlschema'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import { paperShapeId } from '../shared/ids.ts'
import type { GoalScore, PaperKind, PaperStatus } from '../shared/paperCard.ts'
import type { PaperCardShape } from '../shared/shapes.ts'
import type { BoardInfo, RemovedLink } from './canvasTools.ts'
import { readRoom, safeId, type Txn } from './rooms.ts'

// The board DB (T08): everything about a board that isn't a shape, in one SQLite file at
// DATA_DIR/board.db beside the rooms. Migrations go by PRAGMA user_version. A board's row is made
// the first time its room is used, so rooms from before the DB keep working. Board IDs are room
// IDs, run through safeId like the room files.

let dbPath = join(resolve(process.env.DATA_DIR ?? '.data'), 'board.db')
let db: DatabaseSync | null = null

/** Tests point the board DB at a temp file before using it. */
export function setBoardDbPath(path: string) {
	closeBoardDb()
	dbPath = path
}

export function closeBoardDb() {
	db?.close()
	db = null
}

const MIGRATIONS = [
	`
	CREATE TABLE boards (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL DEFAULT '',
		question TEXT NOT NULL DEFAULT '',
		context TEXT NOT NULL DEFAULT '',
		goals TEXT NOT NULL,
		created_by TEXT,
		created_at TEXT NOT NULL
	);
	CREATE TABLE members (
		board_id TEXT NOT NULL,
		member_id TEXT NOT NULL,
		display_name TEXT NOT NULL DEFAULT '',
		last_seen_seq INTEGER NOT NULL DEFAULT 0,
		joined_at TEXT NOT NULL,
		PRIMARY KEY (board_id, member_id)
	);
	CREATE INDEX members_by_member ON members (member_id);
	CREATE TABLE board_papers (
		board_id TEXT NOT NULL,
		paper_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		status TEXT NOT NULL,
		scores TEXT NOT NULL DEFAULT '{}',
		added_by TEXT,
		on_behalf_of TEXT,
		run_id TEXT,
		added_at TEXT NOT NULL,
		PRIMARY KEY (board_id, paper_id)
	);
	CREATE TABLE decisions (
		board_id TEXT NOT NULL,
		paper_id TEXT NOT NULL,
		member_id TEXT NOT NULL,
		decision TEXT NOT NULL CHECK (decision IN ('keep', 'discard')),
		at TEXT NOT NULL,
		PRIMARY KEY (board_id, paper_id, member_id)
	);
	CREATE TABLE events (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		board_id TEXT NOT NULL,
		actor TEXT NOT NULL,
		on_behalf_of TEXT,
		run_id TEXT,
		type TEXT NOT NULL,
		payload TEXT NOT NULL,
		at TEXT NOT NULL
	);
	CREATE INDEX events_by_board ON events (board_id, seq);
	CREATE TABLE removed_links (
		board_id TEXT NOT NULL,
		from_paper TEXT NOT NULL,
		to_paper TEXT NOT NULL,
		kind TEXT NOT NULL,
		removed_by TEXT NOT NULL,
		at TEXT NOT NULL,
		PRIMARY KEY (board_id, from_paper, to_paper, kind)
	);
	CREATE TABLE runs (
		id TEXT PRIMARY KEY,
		board_id TEXT NOT NULL,
		requested_by TEXT NOT NULL,
		started_at TEXT NOT NULL,
		last_event_at TEXT NOT NULL,
		events INTEGER NOT NULL DEFAULT 0
	);
	`,
]

/** The open board DB, migrated to the latest version. */
export function boardDb(): DatabaseSync {
	if (db) return db
	mkdirSync(dirname(dbPath), { recursive: true })
	const opened = new DatabaseSync(dbPath)
	try {
		opened.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000')
		const { user_version } = opened.prepare('PRAGMA user_version').get() as { user_version: number }
		for (let version = user_version; version < MIGRATIONS.length; version++) {
			opened.exec('BEGIN')
			try {
				opened.exec(MIGRATIONS[version])
				opened.exec(`PRAGMA user_version = ${version + 1}`)
				opened.exec('COMMIT')
			} catch (e) {
				opened.exec('ROLLBACK')
				throw e
			}
		}
	} catch (e) {
		opened.close()
		throw e
	}
	return (db = opened)
}

type Row = Record<string, SQLOutputValue>
const all = (sql: string, ...params: SQLInputValue[]) => boardDb().prepare(sql).all(...params) as Row[]
const one = (sql: string, ...params: SQLInputValue[]) => boardDb().prepare(sql).get(...params) as Row | undefined
const run = (sql: string, ...params: SQLInputValue[]) => boardDb().prepare(sql).run(...params)

/** Runs `fn` in one board DB transaction (or inside the one already open). */
export function inTransaction<T>(fn: () => T): T {
	const d = boardDb()
	if (d.isTransaction) return fn()
	d.exec('BEGIN IMMEDIATE')
	try {
		const result = fn()
		d.exec('COMMIT')
		return result
	} catch (e) {
		d.exec('ROLLBACK')
		throw e
	}
}

export const now = () => new Date().toISOString()

function parseJson<T>(text: SQLOutputValue, fallback: T): T {
	try {
		return JSON.parse(String(text)) as T
	} catch {
		return fallback
	}
}

const str = (v: SQLOutputValue) => (v === null ? null : String(v))

// ---- boards

export interface Goal {
	id: string
	label: string
}

/** v4's "Looking for" (viewerState.currentGoal starts on the first). */
export const DEFAULT_GOALS: Goal[] = [
	{ id: 'new-findings', label: 'New findings' },
	{ id: 'methods', label: 'Methods to reuse' },
]

export interface BoardRow {
	id: string
	title: string
	question: string
	context: string
	goals: Goal[]
	createdBy: string | null
	createdAt: string
}

const toBoard = (r: Row): BoardRow => ({
	id: String(r.id),
	title: String(r.title),
	question: String(r.question),
	context: String(r.context),
	goals: parseJson(r.goals, DEFAULT_GOALS),
	createdBy: str(r.created_by),
	createdAt: String(r.created_at),
})

/** The board's row, made with defaults the first time its room is used. */
export function ensureBoard(boardId: string): BoardRow {
	const id = safeId(boardId)
	run('INSERT INTO boards (id, goals, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING', id, JSON.stringify(DEFAULT_GOALS), now())
	return toBoard(one('SELECT * FROM boards WHERE id = ?', id)!)
}

export function findBoard(boardId: string): BoardRow | null {
	const row = one('SELECT * FROM boards WHERE id = ?', safeId(boardId))
	return row ? toBoard(row) : null
}

export interface BoardFields {
	title?: string
	question?: string
	context?: string
	goals?: Goal[]
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** A new board: `b_` plus 10 characters, which is also its room ID. */
export function createBoard(fields: BoardFields, createdBy: string): BoardRow {
	const bytes = crypto.getRandomValues(new Uint8Array(10))
	const id = 'b_' + Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
	run(
		'INSERT INTO boards (id, title, question, context, goals, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
		id,
		fields.title ?? '',
		fields.question ?? '',
		fields.context ?? '',
		JSON.stringify(fields.goals ?? DEFAULT_GOALS),
		createdBy,
		now()
	)
	return toBoard(one('SELECT * FROM boards WHERE id = ?', id)!)
}

/** Changes only the fields given. */
export function updateBoard(boardId: string, fields: BoardFields): BoardRow {
	const board = ensureBoard(boardId)
	const given = Object.entries(fields).filter(([, v]) => v !== undefined)
	const next: BoardRow = { ...board, ...Object.fromEntries(given) }
	run(
		'UPDATE boards SET title = ?, question = ?, context = ?, goals = ? WHERE id = ?',
		next.title,
		next.question,
		next.context,
		JSON.stringify(next.goals),
		board.id
	)
	return next
}

/** Boards the member made or joined, newest first. */
export function boardsOf(memberId: string): BoardRow[] {
	return all(
		`SELECT * FROM boards b WHERE b.created_by = ?
			OR EXISTS (SELECT 1 FROM members m WHERE m.board_id = b.id AND m.member_id = ?)
		ORDER BY b.created_at DESC`,
		memberId,
		memberId
	).map(toBoard)
}

// ---- members

export interface Member {
	memberId: string
	displayName: string
	lastSeenSeq: number
	joinedAt: string
}

const toMember = (r: Row): Member => ({
	memberId: String(r.member_id),
	displayName: String(r.display_name),
	lastSeenSeq: Number(r.last_seen_seq),
	joinedAt: String(r.joined_at),
})

/** Adds the member to the board if they're new (`joined`), and renames them when a name is given. */
export function joinMember(boardId: string, memberId: string, displayName?: string): { member: Member; joined: boolean } {
	const id = ensureBoard(boardId).id
	const { changes } = run(
		'INSERT INTO members (board_id, member_id, display_name, joined_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
		id,
		memberId,
		displayName ?? '',
		now()
	)
	if (displayName !== undefined) {
		run('UPDATE members SET display_name = ? WHERE board_id = ? AND member_id = ?', displayName, id, memberId)
	}
	return { member: findMember(id, memberId)!, joined: Number(changes) > 0 }
}

export function findMember(boardId: string, memberId: string): Member | null {
	const row = one('SELECT * FROM members WHERE board_id = ? AND member_id = ?', safeId(boardId), memberId)
	return row ? toMember(row) : null
}

export function membersOf(boardId: string): Member[] {
	return all('SELECT * FROM members WHERE board_id = ? ORDER BY joined_at, rowid', safeId(boardId)).map(toMember)
}

/** Catch-me-up has shown the feed up to `seq`; never moves back. */
export function markSeen(boardId: string, memberId: string, seq: number) {
	run(
		'UPDATE members SET last_seen_seq = MAX(last_seen_seq, ?) WHERE board_id = ? AND member_id = ?',
		seq,
		safeId(boardId),
		memberId
	)
}

// ---- votes

export type Decision = 'keep' | 'discard'

export interface Votes {
	keepBy: string[]
	discardBy: string[]
}

/** Who kept and who discarded the paper, in the order they voted. */
export function votesFor(boardId: string, paperId: string): Votes {
	const rows = all(
		'SELECT member_id, decision FROM decisions WHERE board_id = ? AND paper_id = ? ORDER BY at, rowid',
		safeId(boardId),
		paperId
	)
	const of = (d: Decision) => rows.filter((r) => r.decision === d).map((r) => String(r.member_id))
	return { keepBy: of('keep'), discardBy: of('discard') }
}

export function hasVotes(boardId: string, paperId: string): boolean {
	return one('SELECT 1 FROM decisions WHERE board_id = ? AND paper_id = ? LIMIT 1', safeId(boardId), paperId) !== undefined
}

/** Sets or (with null) clears one member's decision; returns the one it replaced. */
export function setDecision(boardId: string, paperId: string, memberId: string, decision: Decision | null): Decision | null {
	const id = safeId(boardId)
	const before = one('SELECT decision FROM decisions WHERE board_id = ? AND paper_id = ? AND member_id = ?', id, paperId, memberId)
	const previous = (before?.decision ?? null) as Decision | null
	if (previous === decision) return previous
	run('DELETE FROM decisions WHERE board_id = ? AND paper_id = ? AND member_id = ?', id, paperId, memberId)
	if (decision) {
		run('INSERT INTO decisions (board_id, paper_id, member_id, decision, at) VALUES (?, ?, ?, ?, ?)', id, paperId, memberId, decision, now())
	}
	return previous
}

/** Papers only discarded so far: hidden, and a negative signal for the agent's next run. */
export function discardedIds(boardId: string): string[] {
	return all(
		`SELECT paper_id FROM decisions WHERE board_id = ? GROUP BY paper_id
		HAVING SUM(decision = 'keep') = 0 ORDER BY MIN(at)`,
		safeId(boardId)
	).map((r) => String(r.paper_id))
}

// ---- papers on the board (a mirror of the cards, for clients without the canvas)

export interface BoardPaper {
	paperId: string
	kind: PaperKind
	status: PaperStatus
	scores: Record<string, GoalScore>
	/** "agent", a member ID, or null when unknown. */
	addedBy: string | null
	onBehalfOf: string | null
	runId: string | null
	addedAt: string
}

const toPaper = (r: Row): BoardPaper => ({
	paperId: String(r.paper_id),
	kind: String(r.kind) as PaperKind,
	status: String(r.status) as PaperStatus,
	scores: parseJson(r.scores, {}),
	addedBy: str(r.added_by),
	onBehalfOf: str(r.on_behalf_of),
	runId: str(r.run_id),
	addedAt: String(r.added_at),
})

export const isPaperCard = (r: TLRecord | undefined): r is PaperCardShape => r?.typeName === 'shape' && r.type === 'paper-card'

/** The paper's card; slugs are lossy, so the card's own paperId decides. */
export function findCard(txn: Txn, paperId: string): PaperCardShape | undefined {
	const r = txn.get(paperShapeId(paperId))
	return isPaperCard(r) && r.props.paperId === paperId ? r : undefined
}

/** Writes the card's row; attribution comes from the card's meta the first time. */
export function upsertPaper(boardId: string, card: PaperCardShape) {
	const { meta, props } = card
	const by = meta.createdBy === 'agent' ? 'agent' : typeof meta.author === 'string' ? meta.author : null
	run(
		`INSERT INTO board_papers (board_id, paper_id, kind, status, scores, added_by, on_behalf_of, run_id, added_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (board_id, paper_id) DO UPDATE SET kind = excluded.kind, status = excluded.status, scores = excluded.scores`,
		safeId(boardId),
		props.paperId,
		props.kind,
		props.status,
		JSON.stringify(props.scores),
		by,
		typeof meta.onBehalfOf === 'string' ? meta.onBehalfOf : null,
		typeof meta.runId === 'string' ? meta.runId : null,
		now()
	)
}

/** Reads the room's paper cards and brings board_papers in step: new cards added, gone ones dropped. */
export function syncPapers(boardId: string): PaperCardShape[] {
	const cards = readRoom(boardId, (txn) => [...txn.values()].filter(isPaperCard))
	inTransaction(() => {
		for (const card of cards) upsertPaper(boardId, card)
		const onBoard = new Set(cards.map((c) => c.props.paperId))
		for (const { paperId } of papersOf(boardId)) {
			if (!onBoard.has(paperId)) run('DELETE FROM board_papers WHERE board_id = ? AND paper_id = ?', safeId(boardId), paperId)
		}
	})
	return cards
}

export function papersOf(boardId: string): BoardPaper[] {
	return all('SELECT * FROM board_papers WHERE board_id = ? ORDER BY added_at, rowid', safeId(boardId)).map(toPaper)
}

export function findPaper(boardId: string, paperId: string): BoardPaper | null {
	const row = one('SELECT * FROM board_papers WHERE board_id = ? AND paper_id = ?', safeId(boardId), paperId)
	return row ? toPaper(row) : null
}

/** Papers the member hasn't voted on yet: not seeds, not hidden as discarded. */
export function unvotedCount(boardId: string, memberId: string): number {
	const row = one(
		`SELECT COUNT(*) AS n FROM board_papers p WHERE p.board_id = ? AND p.kind != 'seed' AND p.status != 'discarded'
		AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.board_id = p.board_id AND d.paper_id = p.paper_id AND d.member_id = ?)`,
		safeId(boardId),
		memberId
	)
	return Number(row?.n ?? 0)
}

export function seedCount(boardId: string): number {
	return Number(one("SELECT COUNT(*) AS n FROM board_papers WHERE board_id = ? AND kind = 'seed'", safeId(boardId))?.n ?? 0)
}

// ---- links people removed (T14), so the agent never draws them again

/** Returns false if the link was already recorded. */
export function addRemovedLink(boardId: string, link: RemovedLink, removedBy: string): boolean {
	const { changes } = run(
		'INSERT INTO removed_links (board_id, from_paper, to_paper, kind, removed_by, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
		safeId(boardId),
		link.from,
		link.to,
		link.kind,
		removedBy,
		now()
	)
	return Number(changes) > 0
}

export function removedLinks(boardId: string): RemovedLink[] {
	return all('SELECT from_paper, to_paper, kind FROM removed_links WHERE board_id = ? ORDER BY at, rowid', safeId(boardId)).map(
		(r) => ({ from: String(r.from_paper), to: String(r.to_paper), kind: String(r.kind) as RemovedLink['kind'] })
	)
}

// ---- runs: one per ACP prompt turn, known from the X-Run-Id on its canvas writes

export function touchRun(boardId: string, runId: string, requestedBy: string) {
	const at = now()
	run(
		`INSERT INTO runs (id, board_id, requested_by, started_at, last_event_at, events) VALUES (?, ?, ?, ?, ?, 1)
		ON CONFLICT (id) DO UPDATE SET last_event_at = excluded.last_event_at, events = events + 1`,
		runId,
		safeId(boardId),
		requestedBy,
		at,
		at
	)
}

// ---- what the canvas MCP reads (T02's hook)

export function boardInfo(boardId: string): BoardInfo {
	const board = ensureBoard(boardId)
	return {
		question: board.question,
		goals: board.goals.map((g) => g.id),
		discardedIds: discardedIds(board.id),
		removedLinks: removedLinks(board.id),
	}
}
