import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { RUN_ID_PATTERN } from '../shared/ids.ts'
import { canvasTools, ToolError, type ToolContext } from './canvasTools.ts'
import { papersClient, type PapersClient } from './papersClient.ts'

// The canvas MCP at /api/mcp/canvas/:boardId (T02): every shared board change an agent makes goes
// through here. Stateless streamable HTTP, one server and transport per request, so there's no
// MCP session to lose when the board service restarts.

// External agents don't get our system prompt, so the board rules (interfaces.md I4) travel here.
export const INSTRUCTIONS = `\
Tools for one shared research board: a canvas of paper cards that researchers watch live while you work.
- Never send coordinates. Name the most similar paper already on the board in \`near\` and the board places the card.
- Only add things, or update shapes you added. Shapes people made, and shapes a person moved or edited, come back in \`skipped\` with a reason; respect it and don't work around it.
- Nothing can be deleted through these tools, and agents never vote (Keep and Discard are for people).
- Use get_board for the board's state; it is a compact summary, not raw canvas records.
- Paper IDs are prefixed, as the papers MCP returns them: pmid:34290406, doi:10.1038/s41586-021-03704-y, arxiv:2401.01234.
- To fill a card: mark_working on, add_quote with sentences copied word for word from the abstract, then set_card with oneLine, claims and glance steps that cite those quote IDs, then mark_working off.
- Mention papers in chat answers as [Title](paper:<paperId>) so they become clickable.`

// Demo-grade identity (decision D5): the bearer is a member ID (`m_` plus random characters),
// trusted like the sync socket trusts anyone. T11 adds personal tokens.
const BEARER = /^Bearer\s+(m_[A-Za-z0-9_-]{1,64})$/

const header = (req: IncomingMessage, name: string) => {
	const value = req.headers[name]
	return (Array.isArray(value) ? value[0] : value)?.trim() || null
}

function jsonRpcError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) {
	if (res.headersSent) return res.end()
	res.writeHead(status, { 'content-type': 'application/json', ...headers })
	res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

export function buildCanvasServer(ctx: ToolContext) {
	const server = new McpServer({ name: 'canvas', version: '0.1.0' }, { instructions: INSTRUCTIONS })
	for (const tool of canvasTools) {
		server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (input: unknown) => {
			try {
				const result = await tool.run(ctx, input)
				return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
			} catch (e) {
				// the agent can fix a ToolError; anything else is ours, so log it too
				if (!(e instanceof ToolError)) console.error(`canvas MCP ${tool.name} on ${ctx.boardId}:`, e)
				throw e
			}
		})
	}
	return server
}

export async function handleCanvasMcp(
	req: IncomingMessage,
	res: ServerResponse,
	boardId: string,
	papers: PapersClient = papersClient()
) {
	const member = header(req, 'authorization')?.match(BEARER)?.[1]
	if (!member) {
		return jsonRpcError(res, 401, 'Send Authorization: Bearer <member ID>', { 'www-authenticate': 'Bearer' })
	}
	// stateless: nothing to stream on a GET, and no session for a DELETE to end
	if (req.method !== 'POST') return jsonRpcError(res, 405, 'Method not allowed', { allow: 'POST' })

	const runId = header(req, 'x-run-id')
	const ctx: ToolContext = {
		boardId,
		onBehalfOf: member,
		runId: runId && RUN_ID_PATTERN.test(runId) ? runId : null,
		model: header(req, 'x-model')?.slice(0, 200) ?? null,
		papers,
	}
	const server = buildCanvasServer(ctx)
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
	res.on('close', () => server.close().catch(() => {}))
	try {
		await server.connect(transport)
		await transport.handleRequest(req, res)
	} catch (e) {
		console.error(`canvas MCP request on ${boardId} failed:`, e)
		jsonRpcError(res, 500, 'Internal error')
	}
}
