// The canvas MCP over HTTP with the SDK's own client: node --test server/canvasMcp.test.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { paperShapeId } from '../shared/ids.ts'
import type { PaperCardShape } from '../shared/shapes.ts'
import { handleCanvasMcp, INSTRUCTIONS } from './canvasMcp.ts'
import type { PapersClient } from './papersClient.ts'
import { closeAllRooms, readRoom, setRoomsDir } from './rooms.ts'

const dir = mkdtempSync(join(tmpdir(), 'canvas-mcp-'))
setRoomsDir(dir)

const papers: PapersClient = {
	url: 'http://papers.test/mcp',
	close: async () => {},
	getPaper: async (paperId) => ({ paperId, title: 'T', abstract: 'Malignant cells showed two programs.', url: null }),
}

// a papers MCP that has cluster_papers (I5), for boards whose ID starts with "clusters"
const clustering: PapersClient = {
	...papers,
	hasTool: async (name) => name === 'cluster_papers',
	clusterPapers: async (paperIds) => ({
		clusters: [{ clusterId: 'c1', paperIds, label: 'Melanoma atlas' }],
		similarities: [],
	}),
}

let http: Server
let url: string

before(async () => {
	http = createServer((req, res) => {
		const boardId = req.url?.match(/^\/api\/mcp\/canvas\/([^/]+)$/)?.[1]
		if (boardId) handleCanvasMcp(req, res, boardId, boardId.startsWith('clusters') ? clustering : papers)
		else res.writeHead(404).end()
	})
	await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
	url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/mcp/canvas/`
})

after(async () => {
	await new Promise((resolve) => http.close(resolve))
	closeAllRooms()
	rmSync(dir, { recursive: true, force: true })
})

async function connect(board: string, headers: Record<string, string> = { Authorization: 'Bearer m_test' }) {
	const client = new Client({ name: 'test', version: '0' })
	await client.connect(new StreamableHTTPClientTransport(new URL(url + board), { requestInit: { headers } }))
	return client
}

const json = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text)

test('lists the eight tools and the board rules', async () => {
	const client = await connect('demo')
	const { tools } = await client.listTools()
	assert.deepEqual(tools.map((t) => t.name).sort(), [
		'add_note',
		'add_papers',
		'add_quote',
		'get_board',
		'link_papers',
		'mark_working',
		'set_card',
		'set_scores',
	])
	assert.ok(tools.every((t) => (t.description?.length ?? 0) > 100))
	assert.equal(client.getInstructions(), INSTRUCTIONS)
	await client.close()
})

test('apply_clusters and label_cluster are listed only when the papers MCP has cluster_papers', async () => {
	const client = await connect('clusters1')
	const names = (await client.listTools()).tools.map((t) => t.name)
	assert.equal(names.length, 10)
	assert.ok(names.includes('apply_clusters') && names.includes('label_cluster'))
	json(await client.callTool({ name: 'add_papers', arguments: { papers: [{ paperId: 'pmid:1', title: 'One' }, { paperId: 'pmid:2', title: 'Two', near: 'pmid:1' }] } }))
	const applied = json(await client.callTool({ name: 'apply_clusters', arguments: {} }))
	assert.deepEqual(applied, { clusters: [{ clusterId: 'c1', label: 'Melanoma atlas', paperIds: ['pmid:1', 'pmid:2'] }], skipped: [] })
	assert.deepEqual(json(await client.callTool({ name: 'label_cluster', arguments: { clusterId: 'c1', label: 'Atlas' } })), { ok: true })
	const board = json(await client.callTool({ name: 'get_board', arguments: {} }))
	assert.deepEqual(board.clusters, [{ clusterId: 'c1', label: 'Atlas', labelGenerated: true, humanTouched: false }])
	assert.deepEqual(board.papers.map((p: { cluster: string }) => p.cluster), ['c1', 'c1'])
	await client.close()

	const plain = await connect('plain')
	const tools = (await plain.listTools()).tools.map((t) => t.name)
	assert.ok(!tools.includes('apply_clusters') && !tools.includes('label_cluster'))
	const hidden = await plain.callTool({ name: 'apply_clusters', arguments: {} })
	assert.equal(hidden.isError, true)
	await plain.close()
})

test('tool calls write to the room with attribution from the headers', async () => {
	const client = await connect('b1', { Authorization: 'Bearer m_ana', 'X-Run-Id': 'run_00112233aabb', 'X-Model': 'nvidia/Nemotron-3.5-Super-VL' })
	const added = json(await client.callTool({ name: 'add_papers', arguments: { papers: [{ paperId: 'pmid:1', title: 'One', year: null }] } }))
	assert.deepEqual(added, { added: ['pmid:1'], updated: [], skipped: [] })
	const quote = json(await client.callTool({ name: 'add_quote', arguments: { paperId: 'pmid:1', text: 'two programs' } }))
	assert.deepEqual(quote, { quoteId: 'q1' })
	json(await client.callTool({ name: 'set_card', arguments: { paperId: 'pmid:1', oneLine: 'Finds two programs.', claims: [{ text: 'two programs', evidence: ['q1'] }] } }))

	const card = readRoom('b1', (txn) => txn.get(paperShapeId('pmid:1'))) as PaperCardShape
	assert.deepEqual(card.meta, { createdBy: 'agent', onBehalfOf: 'm_ana', runId: 'run_00112233aabb', paperId: 'pmid:1' })
	assert.equal(card.props.provenance.oneLine.model, 'nvidia/Nemotron-3.5-Super-VL')

	const board = json(await client.callTool({ name: 'get_board', arguments: {} }))
	assert.equal(board.boardId, 'b1')
	assert.equal(board.papers[0].paperId, 'pmid:1')
	await client.close()
})

test('bad input and rule breaks come back as tool errors', async () => {
	const client = await connect('b2')
	const bad = await client.callTool({
		name: 'set_card',
		arguments: { paperId: 'x', figure: { imageUrl: 'http://insecure', label: '', caption: '', captionByAi: true } },
	})
	assert.equal(bad.isError, true)
	assert.match((bad.content as { text: string }[])[0].text, /https/)
	const coords = await client.callTool({ name: 'add_papers', arguments: { papers: [{ paperId: 'a', title: 'A', x: 1 }] } })
	assert.equal(coords.isError, undefined, 'unknown keys like x are dropped, never used')
	const missing = await client.callTool({ name: 'set_scores', arguments: { paperId: 'nope', scores: { methods: { score: 1, fit: 'high', why: '' } } } })
	assert.equal(missing.isError, true)
	assert.match((missing.content as { text: string }[])[0].text, /No card for nope/)
	await client.close()
})

test('401 without a member bearer; 405 for GET and DELETE', async () => {
	const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
	const post = (headers: Record<string, string>) =>
		fetch(url + 'b3', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body })
	assert.equal((await post({})).status, 401)
	assert.equal((await post({ Authorization: 'Bearer nope' })).status, 401)
	await assert.rejects(connect('b3', {}), /Bearer <member ID>/)
	for (const method of ['GET', 'DELETE']) {
		assert.equal((await fetch(url + 'b3', { method, headers: { Authorization: 'Bearer m_test' } })).status, 405)
	}
})
