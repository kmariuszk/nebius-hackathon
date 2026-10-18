// The papers MCP client against a stand-in papers MCP: node --test server/papersClient.test.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { z } from 'zod'
import { createPapersClient } from './papersClient.ts'

let calls = 0
let http: Server
let url: string

// like discovery's server: a dict comes back as structured content, an unknown ID as a tool error
function papersServer() {
	const server = new McpServer({ name: 'papers', version: '0' })
	server.registerTool('get_paper', { inputSchema: { paper_id: z.string() } }, async ({ paper_id }) => {
		calls++
		if (paper_id === 'isbn:1') return { isError: true, content: [{ type: 'text', text: 'Unknown paper ID isbn:1' }] }
		const record = { paperId: paper_id, title: 'Atlas', abstract: 'We profiled cells.', url: 'https://example.org/p' }
		return { structuredContent: record, content: [{ type: 'text', text: JSON.stringify(record) }] }
	})
	// numeric cluster IDs and Concept.md's `score` are read as the board expects them
	server.registerTool('cluster_papers', { inputSchema: { paper_ids: z.array(z.string()) } }, async ({ paper_ids }) => {
		const result = {
			clusters: [{ clusterId: 1, paperIds: paper_ids, label: 'Atlas' }],
			similarities: [{ a: paper_ids[0], b: paper_ids[1], score: 0.8 }],
		}
		return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
	})
	return server
}

before(async () => {
	http = createServer(async (req, res) => {
		const server = papersServer()
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
		res.on('close', () => server.close())
		await server.connect(transport)
		await transport.handleRequest(req, res)
	})
	await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
	url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`
})

after(() => new Promise((resolve) => http.close(resolve)))

test('get_paper returns the record and caches it', async () => {
	const papers = createPapersClient(url)
	const paper = await papers.getPaper('pmid:1')
	assert.equal(paper.abstract, 'We profiled cells.')
	assert.equal((await papers.getPaper('pmid:1')).title, 'Atlas')
	assert.equal(calls, 1)
	await assert.rejects(papers.getPaper('isbn:1'), /no record for isbn:1: Unknown paper ID/)
	await papers.close()
})

test('an unreachable papers MCP is an error that says so', async () => {
	const papers = createPapersClient('http://127.0.0.1:9/mcp')
	await assert.rejects(papers.getPaper('pmid:1'), /papers MCP at http:\/\/127\.0\.0\.1:9\/mcp is unreachable/)
	await papers.close()
})

test('hasTool reads the tool list once; clusterPapers returns the clusters', async () => {
	const papers = createPapersClient(url)
	assert.equal(await papers.hasTool!('cluster_papers'), true)
	assert.equal(await papers.hasTool!('get_figures'), false)
	assert.deepEqual(await papers.clusterPapers!(['pmid:1', 'pmid:2']), {
		clusters: [{ clusterId: '1', paperIds: ['pmid:1', 'pmid:2'], label: 'Atlas' }],
		similarities: [{ a: 'pmid:1', b: 'pmid:2', similarity: 0.8 }],
	})
	await papers.close()
})

test('an unreachable papers MCP lists no tools, quickly', async () => {
	const papers = createPapersClient('http://127.0.0.1:9/mcp')
	const started = Date.now()
	assert.equal(await papers.hasTool!('cluster_papers'), false)
	assert.ok(Date.now() - started < 3500)
	await assert.rejects(papers.clusterPapers!(['a', 'b']), /unreachable/)
	await papers.close()
})
