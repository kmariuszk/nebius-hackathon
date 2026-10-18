// The REST and SSE API over HTTP, beside the canvas MCP, with a stand-in papers MCP:
// node --test server/api.test.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { z } from 'zod'
import { paperShapeId } from '../shared/ids.ts'
import { defaultPaperCardProps, type PaperCardShape } from '../shared/shapes.ts'
import { handleApi } from './api.ts'
import { closeBoardDb, setBoardDbPath } from './boardDb.ts'
import { handleCanvasMcp } from './canvasMcp.ts'
import { streamCount } from './events.ts'
import { createPapersClient, type PapersClient } from './papersClient.ts'
import { setPdfDir } from './pdfProxy.ts'
import { closeAllRooms, putShapes, readRoom, setRoomsDir } from './rooms.ts'

const dir = mkdtempSync(join(tmpdir(), 'board-api-'))
setRoomsDir(join(dir, 'rooms'))
setBoardDbPath(join(dir, 'board.db'))
setPdfDir(join(dir, 'pdfs'))

// like discovery's papers MCP: records as structured content, unknown papers as tool errors
const TIROSH = {
	paperId: 'pmid:27124452',
	ids: { pmid: '27124452', doi: '10.1126/science.aad0501' },
	title: 'Dissecting the multicellular ecosystem of metastatic melanoma by single-cell RNA-seq',
	authors: ['Itay Tirosh', 'Benjamin Izar'],
	year: 2016,
	venue: 'Science',
	url: 'https://doi.org/10.1126/science.aad0501',
	abstract: 'To explore the distinct genotypic and phenotypic states of melanoma tumors, we applied single-cell RNA-seq.',
	openAccessPdf: 'http://127.0.0.1:9/tirosh.pdf',
	type: 'journal-article',
}
const records: Record<string, object> = {
	[TIROSH.paperId]: TIROSH,
	'pmid:2': { paperId: 'pmid:2', title: 'No PDF', openAccessPdf: null },
}

function papersServer() {
	const server = new McpServer({ name: 'papers', version: '0' })
	const reply = (record: object | undefined, missing: string) =>
		record
			? { structuredContent: record as Record<string, unknown>, content: [{ type: 'text' as const, text: JSON.stringify(record) }] }
			: { isError: true, content: [{ type: 'text' as const, text: missing }] }
	server.registerTool('get_paper', { inputSchema: { paper_id: z.string() } }, async ({ paper_id }) =>
		reply(records[paper_id], `Unknown paper ID ${paper_id}`)
	)
	server.registerTool('resolve_seed', { inputSchema: { doi: z.string().optional(), pmid: z.string().optional() } }, async ({ doi, pmid }) =>
		reply(Object.values(records).find((r) => JSON.stringify(r).includes(`"${pmid ?? doi}"`)), `No paper for ${pmid ?? doi}`)
	)
	return server
}

let mcpHttp: Server
let http: Server
let base = ''
let papers: PapersClient

before(async () => {
	mcpHttp = createServer(async (req, res) => {
		const server = papersServer()
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
		res.on('close', () => server.close())
		await server.connect(transport)
		await transport.handleRequest(req, res)
	})
	await new Promise<void>((resolve) => mcpHttp.listen(0, '127.0.0.1', resolve))
	papers = createPapersClient(`http://127.0.0.1:${(mcpHttp.address() as AddressInfo).port}/mcp`)

	http = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost')
		const canvas = url.pathname.match(/^\/api\/mcp\/canvas\/([^/]+)$/)
		if (canvas) handleCanvasMcp(req, res, canvas[1], papers)
		else handleApi(req, res, url, papers)
	})
	await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
	base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
})

after(async () => {
	await papers.close()
	for (const server of [http, mcpHttp]) {
		server.closeAllConnections()
		await new Promise((resolve) => server.close(resolve))
	}
	closeAllRooms()
	closeBoardDb()
	rmSync(dir, { recursive: true, force: true })
})

interface Options {
	member?: string | null
	body?: unknown
	headers?: Record<string, string>
}

async function call(method: string, path: string, { member = 'm_ana', body, headers = {} }: Options = {}) {
	const res = await fetch(`${base}/api/v1${path}`, {
		method,
		headers: {
			...(member ? { authorization: `Bearer ${member}` } : {}),
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
			...headers,
		},
		body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
	})
	const text = await res.text()
	return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined }
}

const vote = (board: string, paperId: string, member: string, decision: string | null) =>
	call('PUT', `/boards/${board}/papers/${encodeURIComponent(paperId)}/vote`, { member, body: { decision } })

let boards = 0
/** A board whose room already has paper cards, as an agent made them. */
function roomWith(...paperIds: string[]) {
	const board = `room${++boards}`
	putShapes(
		board,
		paperIds.map((paperId, i) => ({
			id: paperShapeId(paperId),
			type: 'paper-card',
			x: i * 100,
			y: 0,
			props: defaultPaperCardProps(paperId, { title: `Paper ${paperId}`, kind: i === 0 && paperId.startsWith('seed') ? 'seed' : 'suggestion' }),
			meta: { createdBy: 'agent', onBehalfOf: 'm_ana', runId: null, paperId },
		}))
	)
	return board
}

const cardOf = (board: string, paperId: string) => readRoom(board, (txn) => txn.get(paperShapeId(paperId))) as PaperCardShape

/** Reads an SSE response frame by frame. */
async function listen(path: string, headers: Record<string, string> = {}) {
	const abort = new AbortController()
	const res = await fetch(`${base}/api/v1${path}`, { headers, signal: abort.signal })
	const frames: { id: number; event: string; data: any }[] = []
	const reader = res.body!.getReader()
	const decoder = new TextDecoder()
	let buffer = ''
	void (async () => {
		try {
			for (let read = await reader.read(); !read.done; read = await reader.read()) {
				buffer += decoder.decode(read.value, { stream: true })
				for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
					const fields = Object.fromEntries(
						buffer
							.slice(0, end)
							.split('\n')
							.filter((l) => !l.startsWith(':'))
							.map((l) => [l.slice(0, l.indexOf(': ')), l.slice(l.indexOf(': ') + 2)])
					)
					buffer = buffer.slice(end + 2)
					if (fields.data) frames.push({ id: Number(fields.id), event: fields.event, data: JSON.parse(fields.data) })
				}
			}
		} catch {
			// aborted
		}
	})()
	const until = async (check: () => boolean, ms = 3000) => {
		for (const start = Date.now(); !check(); await new Promise((r) => setTimeout(r, 20))) {
			if (Date.now() - start > ms) throw new Error(`no such frame after ${ms} ms: ${JSON.stringify(frames.map((f) => f.event))}`)
		}
	}
	return { res, frames, until, close: () => abort.abort() }
}

async function canvasMcp(board: string, member = 'm_ana') {
	const client = new Client({ name: 'test', version: '0' })
	const headers = { Authorization: `Bearer ${member}`, 'X-Run-Id': 'run_00112233aabb' }
	await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/mcp/canvas/${board}`), { requestInit: { headers } }))
	const tool = async (name: string, args: Record<string, unknown> = {}) =>
		JSON.parse(((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0].text)
	return { client, tool }
}

test('boards: create one, list the caller’s, read and edit it', async () => {
	const anonymous = await call('POST', '/boards', { member: null, body: {} })
	assert.equal(anonymous.status, 401)
	assert.deepEqual(anonymous.body, { error: { code: 'unauthorized', message: 'Send Authorization: Bearer <member ID>' } })
	assert.equal(anonymous.headers.get('www-authenticate'), 'Bearer')

	const created = await call('POST', '/boards', { body: { title: 'Melanoma', question: 'What predicts response to checkpoint therapy?' } })
	assert.equal(created.status, 201)
	const board = created.body
	assert.match(board.id, /^b_[a-z0-9]{10}$/)
	assert.equal(board.createdBy, 'm_ana')
	assert.deepEqual(board.goals.map((g: { id: string }) => g.id), ['new-findings', 'methods'])
	assert.deepEqual(board.members.map((m: { memberId: string }) => m.memberId), ['m_ana'])
	assert.equal(board.agentActive, false)
	assert.match(board.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)

	assert.ok((await call('GET', '/boards')).body.some((b: { id: string }) => b.id === board.id))
	assert.ok(!(await call('GET', '/boards', { member: 'm_eve' })).body.some((b: { id: string }) => b.id === board.id))

	const goals = [{ id: 'evidence', label: 'Evidence' }]
	const edited = await call('PATCH', `/boards/${board.id}`, { body: { question: 'Which T cells respond?', goals } })
	assert.equal(edited.status, 200)
	assert.equal(edited.body.title, 'Melanoma')
	const read = await call('GET', `/boards/${board.id}`, { member: null })
	assert.equal(read.body.question, 'Which T cells respond?')
	assert.deepEqual(read.body.goals, goals)
	assert.equal(read.body.unvoted, undefined, 'caller-only counts need a bearer')
})

test('opening an old room makes its board row and leaves the canvas as it was', async () => {
	const board = roomWith('seed:1', 'pmid:2')
	const before = readRoom(board, (txn) => [...txn.values()].length)
	const res = await call('GET', `/boards/${board}`)
	assert.equal(res.status, 200)
	assert.equal(res.body.id, board)
	assert.equal(res.body.seedCount, 1)
	assert.equal(res.body.unvoted, 1)
	assert.equal(readRoom(board, (txn) => [...txn.values()].length), before)
})

test('bad requests get a JSON error with a code and the reason', async () => {
	const board = roomWith('pmid:1')
	const cases: [string, string, Options, number, string, RegExp][] = [
		['PUT', `/boards/${board}/papers/pmid%3A1/vote`, { body: { decision: 'maybe' } }, 400, 'invalid', /decision/],
		['PUT', `/boards/${board}/papers/pmid%3A1/vote`, { body: 'not json' }, 400, 'bad_json', /JSON/],
		['PUT', `/boards/${board}/papers/pmid%3A1/vote`, { body: { decision: 'keep', by: 'm_x' } }, 400, 'invalid', /by/],
		['PUT', `/boards/${board}/papers/pmid%3A1/vote`, { member: 'ana', body: { decision: 'keep' } }, 401, 'unauthorized', /Bearer/],
		['PUT', `/boards/${board}/papers/pmid%3A404/vote`, { body: { decision: 'keep' } }, 404, 'not_found', /No card for pmid:404/],
		['GET', '/boards/bad%20board', {}, 400, 'bad_request', /board ID/],
		['PATCH', `/boards/${board}`, { body: {} }, 400, 'invalid', /at least one/],
		['PATCH', `/boards/${board}`, { body: { goals: [{ id: 'Bad Goal', label: 'x' }] } }, 400, 'invalid', /goals\.0\.id/],
		['PUT', `/boards/${board}/removed-links`, { body: { from: 'pmid:1', to: 'pmid:2' } }, 400, 'invalid', /kind/],
		['POST', `/boards/${board}/seeds`, { body: { pmid: 'abc' } }, 400, 'invalid', /PMID/],
		['POST', `/boards/${board}/seen`, { body: { seq: -1 } }, 400, 'invalid', /seq/],
		['GET', `/boards/${board}/papers?status=maybe`, {}, 400, 'invalid', /status/],
		['GET', `/boards/${board}/activity?limit=0`, {}, 400, 'invalid', /limit/],
		['GET', `/boards/${board}/events?after=x`, {}, 400, 'invalid', /seq/],
		['GET', '/nope', {}, 404, 'not_found', /No route/],
	]
	for (const [method, path, options, status, code, message] of cases) {
		const res = await call(method, path, options)
		assert.equal(res.status, status, `${method} ${path}: ${JSON.stringify(res.body)}`)
		assert.equal(res.body.error.code, code, `${method} ${path}`)
		assert.match(res.body.error.message, message, `${method} ${path}`)
	}
	const wrongMethod = await call('DELETE', `/boards/${board}`)
	assert.equal(wrongMethod.status, 405)
	assert.equal(wrongMethod.headers.get('allow'), 'GET, PATCH')
	assert.deepEqual(cardOf(board, 'pmid:1').props.keepBy, [], 'nothing was written')
})

test('Keep and Discard change the card for everyone; the paper record shows the votes and the papers MCP’s fields', async () => {
	const board = roomWith(TIROSH.paperId, 'pmid:9')
	assert.deepEqual((await vote(board, TIROSH.paperId, 'm_ana', 'keep')).body, { status: 'kept', keepBy: ['m_ana'], discardBy: [] })
	assert.equal(cardOf(board, TIROSH.paperId).props.status, 'kept')
	assert.deepEqual((await vote(board, TIROSH.paperId, 'm_ben', 'discard')).body, {
		status: 'contested',
		keepBy: ['m_ana'],
		discardBy: ['m_ben'],
	})
	const card = cardOf(board, TIROSH.paperId).props
	assert.deepEqual([card.status, card.keepBy, card.discardBy], ['contested', ['m_ana'], ['m_ben']])

	const paper = (await call('GET', `/boards/${board}/papers/${encodeURIComponent(TIROSH.paperId)}`, { member: null })).body
	for (const key of ['title', 'authors', 'year', 'venue', 'abstract', 'openAccessPdf', 'ids'] as const) {
		assert.deepEqual(paper[key], TIROSH[key], key)
	}
	assert.equal(paper.pdf, `/api/v1/boards/${board}/papers/pmid%3A27124452/pdf`)
	assert.deepEqual(paper.board, {
		kind: 'suggestion',
		status: 'contested',
		votes: { keep: ['m_ana'], discard: ['m_ben'] },
		working: false,
		addedBy: 'agent',
		onBehalfOf: 'm_ana',
		runId: null,
		addedAt: paper.board.addedAt,
	})
	assert.equal(paper.skipped, undefined)

	const list = (await call('GET', `/boards/${board}/papers`)).body
	assert.deepEqual(list.map((p: { paperId: string }) => p.paperId).sort(), [TIROSH.paperId, 'pmid:9'])
	const contested = (await call('GET', `/boards/${board}/papers?status=contested,kept`)).body
	assert.deepEqual(contested.map((p: { paperId: string; keepBy: string[] }) => [p.paperId, p.keepBy]), [[TIROSH.paperId, ['m_ana']]])

	// the papers MCP doesn't know pmid:9: the board's part still comes back, and says what's missing
	const unknown = (await call('GET', `/boards/${board}/papers/pmid%3A9`)).body
	assert.equal(unknown.title, 'Paper pmid:9')
	assert.match(unknown.skipped[0], /no record for pmid:9/)
})

test('SSE: votes and agent writes arrive as they happen, and a reconnect gets what it missed, once', async () => {
	const board = roomWith('pmid:1')
	const stream = await listen(`/boards/${board}/events`)
	assert.equal(stream.res.headers.get('content-type'), 'text/event-stream; charset=utf-8')
	assert.equal(stream.res.headers.get('x-accel-buffering'), 'no')

	const agent = await canvasMcp(board)
	assert.deepEqual((await agent.tool('add_papers', { papers: [{ paperId: 'pmid:2', title: 'Two', near: 'pmid:1' }] })).added, ['pmid:2'])
	await stream.until(() => stream.frames.some((f) => f.event === 'paper.added'))
	const added = stream.frames.find((f) => f.event === 'paper.added')!
	assert.deepEqual(
		{ ...added.data, at: '' },
		{
			seq: added.id,
			boardId: board,
			actor: 'agent',
			onBehalfOf: 'm_ana',
			runId: 'run_00112233aabb',
			type: 'paper.added',
			payload: { tool: 'add_papers', paperIds: ['pmid:2'] },
			at: '',
		}
	)
	await agent.tool('add_note', { text: 'Worth a look', paperId: 'pmid:2' })
	await vote(board, 'pmid:2', 'm_ana', 'keep')
	await stream.until(() => stream.frames.some((f) => f.event === 'paper.voted'))
	assert.deepEqual(stream.frames.map((f) => f.event), ['paper.added', 'note.added', 'member.joined', 'paper.voted'])
	assert.equal(stream.frames.at(-1)!.data.payload.status, 'kept')
	stream.close()
	await agent.client.close()

	// Ben's vote happens while the stream is away
	const lastId = stream.frames.at(-1)!.id
	await vote(board, 'pmid:2', 'm_ben', 'discard')
	const back = await listen(`/boards/${board}/events`, { 'Last-Event-ID': String(lastId) })
	await back.until(() => back.frames.some((f) => f.event === 'paper.voted'))
	await vote(board, 'pmid:1', 'm_ben', 'keep')
	await back.until(() => back.frames.filter((f) => f.event === 'paper.voted').length === 2)
	assert.deepEqual(back.frames.map((f) => [f.event, f.data.actor]), [
		['member.joined', 'm_ben'],
		['paper.voted', 'm_ben'],
		['paper.voted', 'm_ben'],
	])
	assert.ok(back.frames.every((f, i) => f.id > lastId && (i === 0 || f.id > back.frames[i - 1].id)), 'each once, in order')
	assert.equal(streamCount(board), 1, 'the first stream was cleaned up when it closed')
	back.close()
	await back.until(() => streamCount(board) === 0)

	const fromStart = await listen(`/boards/${board}/events?after=0`)
	await fromStart.until(() => fromStart.frames.length === 7)
	fromStart.close()
	const activity = (await call('GET', `/boards/${board}/activity`)).body
	assert.deepEqual(activity.map((e: { seq: number }) => e.seq), [...fromStart.frames].reverse().map((f) => f.id), 'newest first')
	assert.equal((await call('GET', `/boards/${board}/activity?after=${activity[1].seq}`)).body.length, 1)
})

test('what people discard and the links they remove reach the agent through get_board', async () => {
	const board = roomWith('pmid:a', 'pmid:b')
	await vote(board, 'pmid:a', 'm_ben', 'discard')
	const removed = await call('PUT', `/boards/${board}/removed-links`, { body: { from: 'pmid:a', to: 'pmid:b', kind: 'cites' } })
	assert.equal(removed.status, 204)
	const agent = await canvasMcp(board)
	const view = await agent.tool('get_board')
	assert.deepEqual(view.discardedIds, ['pmid:a'])
	assert.deepEqual(view.removedLinks, [{ from: 'pmid:a', to: 'pmid:b', kind: 'cites' }])
	const linked = await agent.tool('link_papers', { links: [{ from: 'pmid:a', to: 'pmid:b', kind: 'cites' }] })
	assert.deepEqual(linked.skipped, [{ from: 'pmid:a', to: 'pmid:b', kind: 'cites', reason: 'removed by a person' }])
	await agent.client.close()
	const types = (await call('GET', `/boards/${board}/activity`)).body.map((e: { type: string }) => e.type)
	assert.ok(types.includes('link.removed'))
})

test('members join and rename; "seen" clears the Catch me up count', async () => {
	const board = roomWith('pmid:1', 'pmid:2')
	const joined = await call('PUT', `/boards/${board}/members/me`, { body: { displayName: 'Ana' } })
	assert.equal(joined.status, 200)
	assert.equal(joined.body.displayName, 'Ana')
	const renamed = await call('PUT', `/boards/${board}/members/me`, { body: { displayName: 'Ana K.' } })
	assert.deepEqual(renamed.body, { ...joined.body, displayName: 'Ana K.' })

	await vote(board, 'pmid:1', 'm_ben', 'keep')
	const before = (await call('GET', `/boards/${board}`)).body
	assert.equal(before.newSinceLastSeen, 2, "Ben joining and voting; Ana's own join doesn't count")
	assert.equal(before.unvoted, 2)
	assert.equal((await call('POST', `/boards/${board}/seen`, { body: { seq: before.lastSeq } })).status, 204)
	const after = (await call('GET', `/boards/${board}`)).body
	assert.equal(after.newSinceLastSeen, 0)
	assert.deepEqual(after.members.map((m: { memberId: string; displayName: string }) => [m.memberId, m.displayName]), [
		['m_ana', 'Ana K.'],
		['m_ben', ''],
	])
})

test('a seed by PMID becomes a seed card authored by the member; an unknown one is a 404', async () => {
	const board = roomWith('pmid:1')
	const res = await call('POST', `/boards/${board}/seeds`, { body: { pmid: '27124452' } })
	assert.equal(res.status, 201)
	assert.equal(res.body.paperId, TIROSH.paperId)
	assert.equal(res.body.abstract, TIROSH.abstract)
	assert.deepEqual([res.body.board.kind, res.body.board.status, res.body.board.addedBy], ['seed', 'kept', 'm_ana'])
	const card = cardOf(board, TIROSH.paperId)
	assert.deepEqual(card.meta, { author: 'm_ana', paperId: TIROSH.paperId })
	assert.deepEqual([card.props.title, card.props.year, card.props.type], [TIROSH.title, 2016, 'article'])
	assert.equal((await call('POST', `/boards/${board}/seeds`, { body: { pmid: '27124452' } })).status, 201, 'again: same card')
	assert.equal(readRoom(board, (txn) => [...txn.values()].filter((r) => r.typeName === 'shape').length), 2)

	const unknown = await call('POST', `/boards/${board}/seeds`, { body: { pmid: '404' } })
	assert.equal(unknown.status, 404)
	assert.equal(unknown.body.error.code, 'paper_not_found')
	const types = (await call('GET', `/boards/${board}/activity`)).body.map((e: { type: string }) => e.type)
	assert.deepEqual(types.filter((t: string) => t === 'seed.added').length, 2)
})

test('the PDF route refuses a link that isn’t https on a public host, and 404s without one', async () => {
	const board = roomWith(TIROSH.paperId, 'pmid:2')
	const refused = await call('GET', `/boards/${board}/papers/${encodeURIComponent(TIROSH.paperId)}/pdf`)
	assert.equal(refused.status, 502)
	assert.equal(refused.body.error.code, 'pdf_refused')
	assert.match(refused.body.error.message, /Only https/)
	const none = await call('GET', `/boards/${board}/papers/pmid%3A2/pdf`)
	assert.deepEqual([none.status, none.body.error.code], [404, 'no_pdf'])
	assert.equal((await call('GET', `/boards/${board}/papers/pmid%3A3/pdf`)).status, 404)
})
