import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'

// The board service's client of the papers MCP (interfaces.md I5): paper records for quote checks
// (T02) and the REST API (T08), and clusters for apply_clusters once discovery has cluster_papers.
// Records are cached in memory per paper ID; they rarely change.

export const DEFAULT_PAPERS_MCP_URL = 'http://127.0.0.1:8001/mcp'
const TIMEOUT_MS = 15_000
// clustering embeds papers the discovery service hasn't seen yet
const CLUSTER_TIMEOUT_MS = 120_000
const CACHE_MAX = 2000
// the tool list decides which canvas tools exist (I5), so it is checked on every canvas MCP request
const TOOLS_TTL_MS = 30_000
const FIRST_LIST_WAIT_MS = 3_000

/** `get_paper`'s record (discovery's Paper.to_record); fields are null when the sources don't have them. */
export interface PaperRecord {
	paperId: string
	title: string
	authors?: string[]
	year?: number | null
	venue?: string | null
	url?: string | null
	abstract?: string | null
	type?: string | null
	[key: string]: unknown
}

// `cluster_papers`' result (I5): communities over the board's papers, each named by discovery,
// and the k nearest neighbours per paper. `score` is Concept.md's older name for `similarity`.
const clusterResult = z.object({
	clusters: z.array(
		z.object({
			clusterId: z.union([z.string().min(1), z.number()]).transform(String),
			paperIds: z.array(z.string()),
			label: z.string().nullish().transform((v) => v || null),
		})
	),
	similarities: z
		.array(
			z
				.object({ a: z.string(), b: z.string(), similarity: z.number().optional(), score: z.number().optional() })
				.transform(({ a, b, similarity, score }) => ({ a, b, similarity: similarity ?? score ?? 0 }))
		)
		.default([]),
})

export type ClusterResult = z.infer<typeof clusterResult>

export interface PapersClient {
	readonly url: string
	/** Throws an Error whose message says why (unreachable, or the papers MCP's own error such as an unknown ID). */
	getPaper(paperId: string): Promise<PaperRecord>
	/**
	 * Whether the papers MCP lists this tool, so canvas tools that need a planned discovery tool are
	 * hidden until it exists (I5). False while it is unreachable. Clients without it have none.
	 */
	hasTool?(name: string): Promise<boolean>
	/** `cluster_papers`; only called when hasTool('cluster_papers'). Throws like getPaper. */
	clusterPapers?(paperIds: string[]): Promise<ClusterResult>
	close(): Promise<void>
}

interface ToolResult {
	isError?: boolean
	structuredContent?: Record<string, unknown>
	content?: { type: string; text?: string }[]
}

const text = (r: ToolResult) => r.content?.find((c) => c.type === 'text')?.text ?? ''

// Python's MCP server returns a dict as structuredContent, and as JSON text for older clients;
// anything else comes wrapped as {result}.
function valueOf(result: ToolResult): Record<string, unknown> | null {
	let value: unknown = result.structuredContent
	if (!value) {
		try {
			value = JSON.parse(text(result))
		} catch {
			return null
		}
	}
	const record = value as Record<string, unknown> | null
	if (record && Object.keys(record).length === 1 && record.result && typeof record.result === 'object') {
		return record.result as Record<string, unknown>
	}
	return record && typeof record === 'object' ? record : null
}

function recordOf(result: ToolResult): PaperRecord | null {
	const record = valueOf(result)
	return record && typeof record.paperId === 'string' ? (record as PaperRecord) : null
}

export function createPapersClient(url = process.env.PAPERS_MCP_URL || DEFAULT_PAPERS_MCP_URL): PapersClient {
	const cache = new Map<string, PaperRecord>()
	let client: Promise<Client> | null = null

	const connect = () =>
		(client ??= (async () => {
			const c = new Client({ name: 'board-service', version: '0.1.0' })
			await c.connect(new StreamableHTTPClientTransport(new URL(url)), { timeout: TIMEOUT_MS })
			return c
		})())

	// a failed connection is dropped, so the next call tries again (discovery may restart)
	async function close() {
		const c = client
		client = null
		await c?.then((c) => c.close()).catch(() => {})
	}

	async function call(name: string, args: Record<string, unknown>, timeout: number): Promise<ToolResult> {
		try {
			const c = await connect()
			return (await c.callTool({ name, arguments: args }, undefined, { timeout })) as ToolResult
		} catch (e) {
			await close()
			throw new Error(`The papers MCP at ${url} is unreachable (${e instanceof Error ? e.message : e})`)
		}
	}

	// The tool list, refreshed in the background once it is older than TOOLS_TTL_MS; an
	// unreachable papers MCP lists nothing until the next refresh.
	let tools: { names: Set<string>; at: number } | null = null
	let listing: Promise<Set<string>> | null = null
	const listTools = () =>
		(listing ??= (async () => {
			let names = new Set<string>()
			try {
				const c = await connect()
				names = new Set((await c.listTools(undefined, { timeout: TIMEOUT_MS })).tools.map((t) => t.name))
			} catch {
				await close()
			}
			tools = { names, at: Date.now() }
			listing = null
			return names
		})())

	return {
		url,
		close,
		async hasTool(name) {
			if (!tools) {
				// the first request waits a little for the list, never long: discovery may be down
				const wait = new Promise<Set<string>>((resolve) => setTimeout(resolve, FIRST_LIST_WAIT_MS, new Set()).unref())
				return (await Promise.race([listTools(), wait])).has(name)
			}
			if (Date.now() - tools.at > TOOLS_TTL_MS) void listTools()
			return tools.names.has(name)
		},
		async clusterPapers(paperIds) {
			const result = await call('cluster_papers', { paper_ids: paperIds }, CLUSTER_TIMEOUT_MS)
			if (result.isError) throw new Error(`The papers MCP couldn't cluster the papers: ${text(result) || 'unknown error'}`)
			const parsed = clusterResult.safeParse(valueOf(result))
			if (!parsed.success) throw new Error('The papers MCP returned clusters in an unexpected shape')
			return parsed.data
		},
		async getPaper(paperId) {
			const hit = cache.get(paperId)
			if (hit) return hit
			const result = await call('get_paper', { paper_id: paperId }, TIMEOUT_MS)
			if (result.isError) {
				throw new Error(`The papers MCP has no record for ${paperId}: ${text(result) || 'unknown error'}`)
			}
			const record = recordOf(result)
			if (!record) throw new Error(`The papers MCP returned no paper record for ${paperId}`)
			if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
			cache.set(paperId, record)
			return record
		},
	}
}

let shared: PapersClient | undefined

/** The board service's one client, to PAPERS_MCP_URL. */
export const papersClient = () => (shared ??= createPapersClient())
