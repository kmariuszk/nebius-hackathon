import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// The board service's client of the papers MCP (interfaces.md I5): paper records for quote checks
// (T02) and the REST API (T08). Records are cached in memory per paper ID; they rarely change.

export const DEFAULT_PAPERS_MCP_URL = 'http://127.0.0.1:8001/mcp'
const TIMEOUT_MS = 15_000
const CACHE_MAX = 2000

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

export interface PapersClient {
	readonly url: string
	/** Throws an Error whose message says why (unreachable, or the papers MCP's own error such as an unknown ID). */
	getPaper(paperId: string): Promise<PaperRecord>
	close(): Promise<void>
}

interface ToolResult {
	isError?: boolean
	structuredContent?: Record<string, unknown>
	content?: { type: string; text?: string }[]
}

const text = (r: ToolResult) => r.content?.find((c) => c.type === 'text')?.text ?? ''

// Python's MCP server returns a dict as structuredContent, and as JSON text for older clients.
function recordOf(result: ToolResult): PaperRecord | null {
	let value: unknown = result.structuredContent
	if (!value) {
		try {
			value = JSON.parse(text(result))
		} catch {
			return null
		}
	}
	const record = value as Record<string, unknown>
	if (record && !('paperId' in record) && record.result && typeof record.result === 'object') {
		return record.result as PaperRecord
	}
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

	return {
		url,
		close,
		async getPaper(paperId) {
			const hit = cache.get(paperId)
			if (hit) return hit
			let result: ToolResult
			try {
				const c = await connect()
				result = (await c.callTool({ name: 'get_paper', arguments: { paper_id: paperId } }, undefined, {
					timeout: TIMEOUT_MS,
				})) as ToolResult
			} catch (e) {
				await close()
				throw new Error(`The papers MCP at ${url} is unreachable (${e instanceof Error ? e.message : e})`)
			}
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
