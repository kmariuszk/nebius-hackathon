import type { TLShapeId } from '@tldraw/tlschema'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { nodeLabel, normaliseType } from '../shared/display.ts'
import { paperShapeId } from '../shared/ids.ts'
import type { PaperCardProps } from '../shared/paperCard.ts'
import { defaultPaperCardProps, NODE_SIZE, type PaperCardShape } from '../shared/shapes.ts'
import { isAgentActive } from './acpPipe.ts'
import {
	addRemovedLink,
	boardsOf,
	createBoard,
	ensureBoard,
	findCard,
	findMember,
	findPaper,
	joinMember,
	markSeen,
	membersOf,
	papersOf,
	seedCount,
	syncPapers,
	unvotedCount,
	updateBoard,
	upsertPaper,
	type BoardPaper,
	type BoardRow,
} from './boardDb.ts'
import { addEvent, lastSeq, latestEvents, newSince, streamEvents } from './events.ts'
import { placeNear } from './layout.ts'
import { papersClient, PapersError, type PaperRecord, type PapersClient } from './papersClient.ts'
import { PdfError, servePdf } from './pdfProxy.ts'
import { MAX_SEED_PDF_BYTES, pdfSeed, savePdf } from './pdfSeed.ts'
import { HttpError, readRoom, writeRoom, writer } from './rooms.ts'
import { castVote, triage } from './triage.ts'

// The board service's REST API at /api/v1 (T08): boards, members, seeds, papers, votes, removed
// links, the activity feed and its SSE stream. JSON in and out, ISO 8601 UTC times, and errors as
// {"error": {"code", "message"}}. Writes need `Authorization: Bearer <memberId>`, trusted like the
// sync socket (decision D5); reads don't, so an EventSource (which can't send headers) can listen.

const BEARER = /^Bearer\s+(m_[A-Za-z0-9_-]{1,64})$/
/** A board ID is its room ID; the same characters the ACP pipe accepts. */
const BOARD_ID = /^[A-Za-z0-9_-]{1,128}$/
const PAPER_ID = /^[^\s\u0000-\u001f]{1,200}$/u
const MAX_BODY = 64 * 1024

export class ApiError extends Error {
	status: number
	code: string
	constructor(status: number, code: string, message: string) {
		super(message)
		this.status = status
		this.code = code
	}
}

interface Call {
	req: IncomingMessage
	res: ServerResponse
	url: URL
	/** Checked against BOARD_ID; empty for /boards. */
	boardId: string
	paperId: string
	member: string | null
	papers: PapersClient
}

/** A JSON reply (no body: 204), or null when the handler wrote the response itself. */
type Reply = { status: number; body?: unknown } | null
type Handler = (c: Call) => Reply | Promise<Reply>

const ok = (body: unknown): Reply => ({ status: 200, body })
const NO_CONTENT: Reply = { status: 204 }

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
	if (res.headersSent) return res.end()
	if (body === undefined) {
		res.writeHead(status, headers)
		return res.end()
	}
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
	res.end(JSON.stringify(body))
}

const CODES: Record<number, string> = { 400: 'bad_request', 404: 'not_found', 409: 'conflict', 503: 'unavailable' }

function fail(res: ServerResponse, e: unknown) {
	const error = (status: number, code: string, message: string, headers?: Record<string, string>) =>
		send(res, status, { error: { code, message } }, headers)
	if (e instanceof ApiError) {
		const headers: Record<string, string> = e.status === 401 ? { 'www-authenticate': 'Bearer' } : {}
		return error(e.status, e.code, e.message, headers)
	}
	if (e instanceof HttpError) return error(e.status, CODES[e.status] ?? 'error', e.message)
	if (e instanceof PapersError) {
		return e.code === 'not_found' ? error(404, 'paper_not_found', e.message) : error(502, 'papers_unavailable', e.message)
	}
	if (e instanceof PdfError) return error(502, e.refused ? 'pdf_refused' : 'pdf_unavailable', e.message)
	if (e instanceof Error && e.name === 'ValidationError') return error(400, 'invalid', String(e.message))
	console.error('REST API:', e)
	error(500, 'internal', 'Internal error')
}

function needMember(c: Call): string {
	if (!c.member) throw new ApiError(401, 'unauthorized', 'Send Authorization: Bearer <member ID>')
	return c.member
}

function param(raw: string, pattern: RegExp, what: string): string {
	let value: string
	try {
		value = decodeURIComponent(raw)
	} catch {
		throw new ApiError(400, 'bad_request', `Bad ${what} in the path`)
	}
	if (!pattern.test(value)) throw new ApiError(400, 'bad_request', `Bad ${what}: ${value.slice(0, 200)}`)
	return value
}

const issues = (error: z.ZodError) =>
	error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ')

async function readBody<S extends z.ZodType>(req: IncomingMessage, schema: S): Promise<z.infer<S>> {
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of req as AsyncIterable<Buffer>) {
		size += chunk.length
		if (size > MAX_BODY) throw new ApiError(413, 'too_large', `The body is over ${MAX_BODY} bytes`)
		chunks.push(chunk)
	}
	let value: unknown
	try {
		value = JSON.parse(Buffer.concat(chunks).toString() || 'null')
	} catch {
		throw new ApiError(400, 'bad_json', 'The body must be JSON')
	}
	const parsed = schema.safeParse(value)
	if (!parsed.success) throw new ApiError(400, 'invalid', issues(parsed.error))
	return parsed.data
}

function readQuery<S extends z.ZodType>(url: URL, schema: S): z.infer<S> {
	const parsed = schema.safeParse(Object.fromEntries(url.searchParams))
	if (!parsed.success) throw new ApiError(400, 'invalid', issues(parsed.error))
	return parsed.data
}

// ---- input

const text = (max: number) => z.string().trim().max(max)
const goalId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'goal IDs look like new-findings')
const goals = z
	.array(z.object({ id: goalId, label: text(60).min(1) }).strict())
	.min(1)
	.max(8)
	.refine((g) => new Set(g.map((x) => x.id)).size === g.length, 'goal IDs must differ')
const boardInput = z.object({ title: text(200).optional(), question: text(2000).optional(), context: text(10_000).optional() }).strict()
const boardPatch = boardInput
	.extend({ goals: goals.optional() })
	.refine((b) => Object.values(b).some((v) => v !== undefined), 'Give at least one of title, question, context, goals')
// without a name, a new member joins with an empty one and a known one keeps theirs
const memberInput = z.object({ displayName: text(40).optional() }).strict()
const seenInput = z.object({ seq: z.number().int().min(0) }).strict()
const seedInput = z.union([
	z.object({ doi: z.string().trim().min(3).max(300) }).strict(),
	z.object({ pmid: z.string().trim().regex(/^\d{1,9}$/, 'a PMID is digits') }).strict(),
])
const voteInput = z.object({ decision: z.enum(['keep', 'discard']).nullable() }).strict()
const paperIdInput = z.string().regex(PAPER_ID, 'not a paper ID')
const removedLinkInput = z.object({ from: paperIdInput, to: paperIdInput, kind: z.enum(['cites', 'similar', 'user']) }).strict()

const STATUSES = ['new', 'kept', 'contested', 'discarded'] as const
const KINDS = ['seed', 'kept', 'suggestion'] as const
const list = <T extends string>(values: readonly [T, ...T[]]) =>
	z
		.string()
		.transform((s) => s.split(',').filter(Boolean))
		.pipe(z.array(z.enum(values)))
const papersQuery = z.object({
	sort: z.enum(['rank', 'added']).default('rank'),
	status: list(STATUSES).optional(),
	kind: list(KINDS).optional(),
	goal: goalId.optional(),
})
const seq = z.coerce.number().int().min(0)
const activityQuery = z.object({ after: seq.default(0), limit: z.coerce.number().int().min(1).max(500).default(100) })

// ---- views

// the room's cards are read first, so the seed and paper counts are up to date
function boardView(board: BoardRow, caller: string | null) {
	const seen = caller ? (findMember(board.id, caller)?.lastSeenSeq ?? 0) : 0
	const paperCount = syncPapers(board.id).length
	const fresh = caller ? newSince(board.id, seen, caller) : 0
	return {
		...board,
		members: membersOf(board.id),
		seedCount: seedCount(board.id),
		paperCount,
		lastSeq: lastSeq(board.id),
		agentActive: isAgentActive(board.id),
		// for the caller: papers they haven't voted on, and the "Catch me up" badge (T13; Home calls it newCount)
		...(caller ? { unvoted: unvotedCount(board.id, caller), newSinceLastSeen: fresh, newCount: fresh } : {}),
	}
}

function paperRow(card: PaperCardShape, row: BoardPaper | null) {
	const p = card.props
	return {
		paperId: p.paperId,
		label: nodeLabel(p.authors, p.year),
		title: p.title,
		authors: p.authors,
		year: p.year,
		venue: p.venue,
		type: p.type,
		kind: p.kind,
		status: p.status,
		scores: p.scores,
		keepBy: p.keepBy,
		discardBy: p.discardBy,
		working: p.working,
		addedBy: row?.addedBy ?? null,
		onBehalfOf: row?.onBehalfOf ?? null,
		runId: row?.runId ?? null,
		addedAt: row?.addedAt ?? null,
	}
}

// drops empty strings, lists and objects, so missing parts are left out rather than blank
function compact(o: Record<string, unknown>): Record<string, unknown> | undefined {
	const kept = Object.entries(o).filter(
		([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)
	)
	return kept.length ? Object.fromEntries(kept) : undefined
}

/** Concept's paper record: the papers MCP's fields, what the card shows, and the board's part. */
function paperView(boardId: string, card: PaperCardShape, row: BoardPaper | null, record: PaperRecord | null, skipped: string[]) {
	const p = card.props
	const pdf = record?.openAccessPdf ? `/api/v1/boards/${boardId}/papers/${encodeURIComponent(p.paperId)}/pdf` : undefined
	return {
		...compact({
			paperId: p.paperId,
			ids: record?.ids,
			title: record?.title || p.title,
			authors: record?.authors?.length ? record.authors : p.authors,
			year: record?.year ?? p.year,
			venue: record?.venue || p.venue,
			url: record?.url || p.url,
			abstract: record?.abstract,
			openAccessPdf: record?.openAccessPdf,
			pdf,
			type: p.type,
			typeRaw: p.typeRaw,
			peerReviewed: p.peerReviewed,
			citedBy: p.citedBy,
			relevance: compact({ scores: p.scores, claims: p.claims, quotes: p.quotes, glance: p.glance, figure: p.figure, gaps: p.gaps }),
			reading: compact({ whyItMatters: p.oneLine, summary: p.summary, provenance: p.provenance }),
			foundBy: p.foundBy,
		}),
		board: {
			kind: p.kind,
			status: p.status,
			votes: { keep: p.keepBy, discard: p.discardBy },
			working: p.working,
			addedBy: row?.addedBy ?? null,
			onBehalfOf: row?.onBehalfOf ?? null,
			runId: row?.runId ?? null,
			addedAt: row?.addedAt ?? null,
		},
		...(skipped.length ? { skipped } : {}),
	}
}

function needCard(boardId: string, paperId: string): PaperCardShape {
	const card = readRoom(boardId, (txn) => findCard(txn, paperId))
	if (!card) throw new ApiError(404, 'not_found', `No card for ${paperId} on this board`)
	return card
}

/** Adds the member to the board if they're new, with a member.joined event. */
function join(boardId: string, memberId: string, displayName?: string) {
	const { member, joined } = joinMember(boardId, memberId, displayName)
	if (joined) addEvent({ boardId, actor: memberId, type: 'member.joined', payload: { memberId, displayName: member.displayName } })
	return member
}

// ---- routes

async function postBoard(c: Call): Promise<Reply> {
	const member = needMember(c)
	const board = createBoard(await readBody(c.req, boardInput), member)
	addEvent({ boardId: board.id, actor: member, type: 'board.created', payload: { title: board.title } })
	join(board.id, member)
	return { status: 201, body: boardView(board, member) }
}

function listBoards(c: Call): Reply {
	const member = needMember(c)
	return ok(boardsOf(member).map((b) => boardView(b, member)))
}

function getBoard(c: Call): Reply {
	// opening an old room makes its row
	return ok(boardView(ensureBoard(c.boardId), c.member))
}

async function patchBoard(c: Call): Promise<Reply> {
	const member = needMember(c)
	const board = updateBoard(c.boardId, await readBody(c.req, boardPatch))
	join(board.id, member)
	return ok(boardView(board, member))
}

async function putMember(c: Call): Promise<Reply> {
	const member = needMember(c)
	const { displayName } = await readBody(c.req, memberInput)
	return ok(join(c.boardId, member, displayName))
}

async function postSeen(c: Call): Promise<Reply> {
	const member = needMember(c)
	const { seq } = await readBody(c.req, seenInput)
	join(c.boardId, member)
	markSeen(c.boardId, member, Math.min(seq, lastSeq(c.boardId)))
	return NO_CONTENT
}

function seedFields(r: PaperRecord): Partial<PaperCardProps> {
	return {
		title: r.title || r.paperId,
		authors: Array.isArray(r.authors) ? r.authors.filter((a) => typeof a === 'string') : [],
		year: Number.isInteger(r.year) ? (r.year as number) : null,
		venue: r.venue ?? '',
		url: r.url ?? '',
		type: normaliseType(r.type),
		typeRaw: r.type ?? '',
	}
}

// the form around the file: field headers and boundaries
const MAX_FORM = MAX_SEED_PDF_BYTES + 64 * 1024

/** The `file` of a multipart/form-data body: a PDF of at most 20 MB. */
async function readPdfForm(req: IncomingMessage): Promise<{ name: string; data: Uint8Array }> {
	const tooLarge = () => new ApiError(413, 'too_large', `A PDF can be at most ${MAX_SEED_PDF_BYTES / 1024 / 1024} MB`)
	if (Number(req.headers['content-length'] ?? 0) > MAX_FORM) throw tooLarge()
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of req as AsyncIterable<Buffer>) {
		size += chunk.length
		if (size > MAX_FORM) throw tooLarge()
		chunks.push(chunk)
	}
	let form: FormData
	try {
		form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData()
	} catch {
		throw new ApiError(400, 'bad_request', 'The body must be multipart/form-data')
	}
	const file = form.get('file')
	if (!(file instanceof File)) throw new ApiError(400, 'invalid', 'Send the PDF as the form field "file"')
	const name = file.name || 'the file'
	if (file.type !== 'application/pdf') throw new ApiError(415, 'unsupported_type', `${name} isn't a PDF`)
	if (file.size > MAX_SEED_PDF_BYTES) throw tooLarge()
	return { name, data: new Uint8Array(await file.arrayBuffer()) }
}

const notFound = (e: unknown): e is PapersError => e instanceof PapersError && e.code === 'not_found'

// A dropped PDF (T16) is looked up by the first DOI in it, else by its title; it's kept with the
// uploads once it has become a seed.
async function resolvePdf(c: Call, resolveSeed: NonNullable<PapersClient['resolveSeed']>) {
	const { name, data } = await readPdfForm(c.req)
	let found: Awaited<ReturnType<typeof pdfSeed>>
	try {
		found = await pdfSeed(data)
	} catch {
		throw new ApiError(422, 'bad_pdf', `Couldn't read ${name} as a PDF. Paste its DOI instead.`)
	}
	let doiMiss: PapersError | null = null
	for (const seed of [found.doi && { doi: found.doi }, found.title && { title: found.title }]) {
		if (!seed) continue
		try {
			return { record: await resolveSeed(seed), upload: savePdf(data) }
		} catch (e) {
			if (!notFound(e)) throw e
			if ('doi' in seed) doiMiss = e
		}
	}
	throw doiMiss ?? new ApiError(422, 'no_doi', `Couldn't find a DOI in ${name}. Paste its DOI instead.`)
}

// A new seed card is placed right of the board's content, authored by the member; a card already
// there (an agent's suggestion, say) becomes a seed. The seed is a DOI, a PMID, or a PDF.
async function postSeed(c: Call): Promise<Reply> {
	const member = needMember(c)
	const pdf = /^multipart\/form-data\b/i.test(c.req.headers['content-type'] ?? '')
	const seed = pdf ? null : await readBody(c.req, seedInput)
	if (!c.papers.resolveSeed) throw new ApiError(501, 'not_implemented', 'This papers client has no resolve_seed')
	const { record, upload } = seed ? { record: await c.papers.resolveSeed(seed), upload: null } : await resolvePdf(c, c.papers.resolveSeed)
	join(c.boardId, member)
	const card = writeRoom(c.boardId, (txn) => {
		const w = writer(txn)
		const existing = findCard(txn, record.paperId)
		if (existing?.props.kind === 'seed') return existing
		const size = NODE_SIZE.square.min
		if (existing) {
			const { status, kind } = triage('seed', existing.props)
			const grown = Math.max(existing.props.w, size)
			return w.patchShape({ id: existing.id, props: { kind, status, w: grown, h: grown } }) as PaperCardShape
		}
		const at = placeNear([...txn.values()], { w: size, h: size }, null)
		return w.createShape({
			id: paperShapeId(record.paperId) as TLShapeId,
			type: 'paper-card',
			...at,
			props: defaultPaperCardProps(record.paperId, { ...seedFields(record), kind: 'seed', status: 'kept', w: size, h: size }),
			meta: { author: member, paperId: record.paperId },
		}) as PaperCardShape
	})
	upsertPaper(c.boardId, card)
	addEvent({ boardId: c.boardId, actor: member, type: 'seed.added', payload: { paperId: record.paperId, title: card.props.title } })
	const body = paperView(c.boardId, card, findPaper(c.boardId, record.paperId), record, [])
	return { status: 201, body: upload ? { ...body, upload: `/api/uploads/${upload}` } : body }
}

function listPapers(c: Call): Reply {
	const { sort, status, kind, goal } = readQuery(c.url, papersQuery)
	const cards = syncPapers(c.boardId).filter(
		(card) => (!status || status.includes(card.props.status)) && (!kind || kind.includes(card.props.kind))
	)
	const rows = new Map(papersOf(c.boardId).map((r) => [r.paperId, r]))
	const papers = cards.map((card) => paperRow(card, rows.get(card.props.paperId) ?? null))
	if (sort === 'added') papers.sort((a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? ''))
	else {
		// best fit for the goal first (the board's first goal unless one is named); unscored last
		const g = goal ?? ensureBoard(c.boardId).goals[0]?.id ?? ''
		papers.sort((a, b) => (b.scores[g]?.score ?? -1) - (a.scores[g]?.score ?? -1))
	}
	return ok(papers)
}

async function getPaper(c: Call): Promise<Reply> {
	const card = needCard(c.boardId, c.paperId)
	let record: PaperRecord | null = null
	const skipped: string[] = []
	try {
		record = await c.papers.getPaper(c.paperId)
	} catch (e) {
		if (!(e instanceof PapersError)) throw e
		skipped.push(e.message)
	}
	return ok(paperView(c.boardId, card, findPaper(c.boardId, c.paperId), record, skipped))
}

async function putVote(c: Call): Promise<Reply> {
	const member = needMember(c)
	const { decision } = await readBody(c.req, voteInput)
	join(c.boardId, member)
	return ok(castVote(c.boardId, c.paperId, member, decision))
}

async function getPdf(c: Call): Promise<Reply> {
	needCard(c.boardId, c.paperId)
	await servePdf(c.res, c.paperId, async () => {
		const link = (await c.papers.getPaper(c.paperId)).openAccessPdf
		if (!link) throw new ApiError(404, 'no_pdf', `No open-access PDF is known for ${c.paperId}`)
		return link
	})
	return null
}

async function putRemovedLink(c: Call): Promise<Reply> {
	const member = needMember(c)
	const link = await readBody(c.req, removedLinkInput)
	join(c.boardId, member)
	if (addRemovedLink(c.boardId, link, member)) addEvent({ boardId: c.boardId, actor: member, type: 'link.removed', payload: link })
	return NO_CONTENT
}

function getActivity(c: Call): Reply {
	const { after, limit } = readQuery(c.url, activityQuery)
	ensureBoard(c.boardId)
	return ok(latestEvents(c.boardId, after, limit))
}

function getEvents(c: Call): Reply {
	const raw = c.req.headers['last-event-id'] ?? c.url.searchParams.get('after')
	let after: number | null = null
	if (raw !== undefined && raw !== null && raw !== '') {
		const parsed = seq.safeParse(raw)
		if (!parsed.success) throw new ApiError(400, 'invalid', 'Last-Event-ID and ?after= take an event seq')
		after = parsed.data
	}
	streamEvents(c.res, c.boardId, after)
	return null
}

const B = '([^/]+)'
const route = (method: string, path: string, handler: Handler) => ({ method, pattern: new RegExp(`^/api/v1${path}$`), handler })

const routes = [
	route('POST', '/boards', postBoard),
	route('GET', '/boards', listBoards),
	route('GET', `/boards/${B}`, getBoard),
	route('PATCH', `/boards/${B}`, patchBoard),
	route('PUT', `/boards/${B}/members/me`, putMember),
	route('POST', `/boards/${B}/seen`, postSeen),
	route('POST', `/boards/${B}/seeds`, postSeed),
	route('GET', `/boards/${B}/papers`, listPapers),
	route('GET', `/boards/${B}/papers/${B}`, getPaper),
	route('PUT', `/boards/${B}/papers/${B}/vote`, putVote),
	route('GET', `/boards/${B}/papers/${B}/pdf`, getPdf),
	route('PUT', `/boards/${B}/removed-links`, putRemovedLink),
	route('GET', `/boards/${B}/activity`, getActivity),
	route('GET', `/boards/${B}/events`, getEvents),
]

/** Everything under /api/v1. */
export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, papers: PapersClient = papersClient()) {
	try {
		const matching = routes.filter((r) => r.pattern.test(url.pathname))
		if (!matching.length) throw new ApiError(404, 'not_found', `No route ${url.pathname}`)
		const r = matching.find((r) => r.method === req.method)
		if (!r) {
			res.setHeader('allow', matching.map((m) => m.method).join(', '))
			throw new ApiError(405, 'method_not_allowed', `${req.method} isn't allowed here`)
		}
		const [, board, paper] = url.pathname.match(r.pattern)!
		const header = req.headers.authorization
		const reply = await r.handler({
			req,
			res,
			url,
			boardId: board ? param(board, BOARD_ID, 'board ID') : '',
			paperId: paper ? param(paper, PAPER_ID, 'paper ID') : '',
			member: (Array.isArray(header) ? header[0] : header)?.trim().match(BEARER)?.[1] ?? null,
			papers,
		})
		if (reply) send(res, reply.status, reply.body)
	} catch (e) {
		fail(res, e)
	}
}
