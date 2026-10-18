import type { ServerResponse } from 'node:http'
import type { BoardEvent } from './canvasTools.ts'
import { boardDb, ensureBoard, now, syncPapers, touchRun } from './boardDb.ts'
import { safeId } from './rooms.ts'

// The activity feed (T08): events in the board DB, numbered by `seq`, and streamed over SSE as
// they're added. Agents' canvas writes come in through recordEvent (T02's hook); votes and the
// other REST writes call addEvent. Payloads stay small: IDs, titles, counts.

export type EventType =
	| 'board.created'
	| 'member.joined'
	| 'seed.added'
	| 'paper.added'
	| 'paper.updated'
	| 'paper.linked'
	| 'note.added'
	| 'highlight.added'
	| 'quote.added'
	| 'paper.voted'
	| 'link.removed'
	| 'agent.active'
	| 'agent.idle'
	/** An agent write the feed has no type for yet, such as a new canvas tool; `payload.tool` names it. */
	| 'board.changed'

type Payload = Record<string, unknown>

export interface StoredEvent {
	seq: number
	boardId: string
	/** "agent" or a member ID. */
	actor: string
	onBehalfOf: string | null
	runId: string | null
	type: EventType
	payload: Payload
	at: string
}

export interface NewEvent {
	boardId: string
	actor: string
	onBehalfOf?: string | null
	runId?: string | null
	type: EventType
	payload: Payload
}

type Listener = (event: StoredEvent) => void
const listeners = new Map<string, Set<Listener>>()

function subscribe(boardId: string, listener: Listener) {
	const set = listeners.get(boardId) ?? new Set()
	listeners.set(boardId, set.add(listener))
	return () => {
		set.delete(listener)
		if (!set.size) listeners.delete(boardId)
	}
}

/** For tests: how many streams are open on the board. */
export const streamCount = (boardId: string) => listeners.get(safeId(boardId))?.size ?? 0

/** Stores the event and sends it to every open stream on the board. Call it after the change is committed. */
export function addEvent(event: NewEvent): StoredEvent {
	const boardId = ensureBoard(event.boardId).id
	const stored = { ...event, boardId, onBehalfOf: event.onBehalfOf ?? null, runId: event.runId ?? null, seq: 0, at: now() }
	const { lastInsertRowid } = boardDb()
		.prepare('INSERT INTO events (board_id, actor, on_behalf_of, run_id, type, payload, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
		.run(boardId, stored.actor, stored.onBehalfOf, stored.runId, stored.type, JSON.stringify(stored.payload), stored.at)
	stored.seq = Number(lastInsertRowid)
	for (const listener of listeners.get(boardId) ?? []) {
		try {
			listener(stored)
		} catch (e) {
			console.error(`An event stream on ${boardId} failed:`, e)
		}
	}
	return stored
}

const toEvent = (r: Record<string, unknown>): StoredEvent => ({
	seq: Number(r.seq),
	boardId: String(r.board_id),
	actor: String(r.actor),
	onBehalfOf: r.on_behalf_of === null ? null : String(r.on_behalf_of),
	runId: r.run_id === null ? null : String(r.run_id),
	type: String(r.type) as EventType,
	payload: JSON.parse(String(r.payload)),
	at: String(r.at),
})

/** Oldest first, for replaying what a stream missed. */
export function eventsAfter(boardId: string, after: number, limit: number): StoredEvent[] {
	return boardDb()
		.prepare('SELECT * FROM events WHERE board_id = ? AND seq > ? ORDER BY seq LIMIT ?')
		.all(safeId(boardId), after, limit)
		.map(toEvent)
}

/** The feed, newest first. */
export function latestEvents(boardId: string, after: number, limit: number): StoredEvent[] {
	return boardDb()
		.prepare('SELECT * FROM events WHERE board_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?')
		.all(safeId(boardId), after, limit)
		.map(toEvent)
}

export function lastSeq(boardId: string): number {
	const row = boardDb().prepare('SELECT MAX(seq) AS seq FROM events WHERE board_id = ?').get(safeId(boardId))
	return Number(row?.seq ?? 0)
}

/** Background noise for the "Catch me up" badge: the agent reading, scoring, coming and going. */
const QUIET: EventType[] = ['paper.updated', 'agent.active', 'agent.idle']

/** Events since `seq` that someone other than `memberId` caused, for the "Catch me up" badge (T13). */
export function newSince(boardId: string, seq: number, memberId: string): number {
	const row = boardDb()
		.prepare(
			`SELECT COUNT(*) AS n FROM events WHERE board_id = ? AND seq > ? AND actor != ?
			AND type NOT IN (${QUIET.map(() => '?').join(', ')})`
		)
		.get(safeId(boardId), seq, memberId, ...QUIET)
	return Number(row?.n ?? 0)
}

// ---- agent writes (T02's hook)

// Canvas tool results to feed events. A tool this doesn't know yet becomes board.changed.
function agentEvents(tool: string, p: Payload): [EventType, Payload][] {
	const out: [EventType, Payload][] = []
	const has = (v: unknown) => Array.isArray(v) && v.length > 0
	switch (tool) {
		case 'add_papers':
			if (has(p.added)) out.push(['paper.added', { tool, paperIds: p.added }])
			if (has(p.updated)) out.push(['paper.updated', { tool, paperIds: p.updated, fields: ['metadata'] }])
			break
		case 'set_scores':
			out.push(['paper.updated', { tool, paperIds: [p.paperId], fields: ['scores'], goals: p.goals }])
			break
		case 'set_card':
			out.push(['paper.updated', { tool, paperIds: [p.paperId], fields: p.fields }])
			break
		case 'mark_working':
			out.push(['paper.updated', { tool, paperIds: p.paperIds, fields: ['working'], working: p.on }])
			break
		case 'add_quote':
			out.push(['quote.added', { tool, ...p }])
			break
		case 'link_papers':
			out.push(['paper.linked', { tool, links: p.linked }])
			break
		case 'add_note':
			out.push(['note.added', { tool, ...p }])
			break
		default:
			out.push(['board.changed', { tool, ...p }])
	}
	return out
}

/**
 * Every agent write to the canvas, after its room transaction. Never throws: the write is already
 * on the board, and a broken feed mustn't make the agent think it failed.
 */
export function recordEvent(event: BoardEvent) {
	try {
		const boardId = safeId(event.boardId)
		// so GET /boards counts and GET /papers see new cards and scores without opening the room
		if (event.type === 'add_papers' || event.type === 'set_scores') syncPapers(boardId)
		if (event.runId) touchRun(boardId, event.runId, event.onBehalfOf)
		for (const [type, payload] of agentEvents(event.type, (event.payload ?? {}) as Payload)) {
			addEvent({ boardId, actor: 'agent', onBehalfOf: event.onBehalfOf, runId: event.runId, type, payload })
		}
	} catch (e) {
		console.error(`Couldn't record ${event.type} on ${event.boardId} in the activity feed:`, e)
	}
}

/** The ACP pipe gained the board's first harness (active) or lost its last; never throws. */
export function recordAgentPresence(boardId: string, active: boolean) {
	try {
		addEvent({ boardId, actor: 'agent', type: active ? 'agent.active' : 'agent.idle', payload: {} })
	} catch (e) {
		console.error(`Couldn't record the agent's presence on ${boardId}:`, e)
	}
}

// ---- SSE

export const HEARTBEAT_MS = 15_000
const REPLAY_PAGE = 500

/**
 * Streams the board's events as SSE frames (`id: <seq>`, `event: <type>`, `data: <json>`). With
 * `after` (Last-Event-ID or ?after=), what came after it is replayed from the DB first, once.
 */
export function streamEvents(res: ServerResponse, boardId: string, after: number | null) {
	const id = ensureBoard(boardId).id
	res.writeHead(200, {
		'content-type': 'text/event-stream; charset=utf-8',
		'cache-control': 'no-cache, no-transform',
		connection: 'keep-alive',
		// nginx-style proxies otherwise hold frames back
		'x-accel-buffering': 'no',
	})
	let last = after ?? lastSeq(id)
	const send = (e: StoredEvent) => {
		if (e.seq <= last) return
		last = e.seq
		res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
	}
	res.write(': connected\n\n')
	// the replay and the subscription run in the same tick, so no event falls between them
	for (let page = eventsAfter(id, last, REPLAY_PAGE); page.length; page = eventsAfter(id, last, REPLAY_PAGE)) {
		page.forEach(send)
	}
	const unsubscribe = subscribe(id, send)
	const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS)
	res.on('close', () => {
		clearInterval(heartbeat)
		unsubscribe()
	})
}
