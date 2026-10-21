import * as acp from '@agentclientprotocol/sdk'
import { createWebSocketStream, type WebSocketConstructor } from '@agentclientprotocol/sdk/experimental/ws-client'
import {
	CANVAS_METHODS,
	focusParams,
	highlightParams,
	openPaperParams,
	snapshotParams,
	tourParams,
} from '../../shared/acpExt.ts'
import { takeSnapshot } from './snapshot.ts'
import { viewerBus } from './viewerBus.ts'

// The browser's ACP client (T05, decision D10): the SDK's builder API over its WebSocket stream to
// the ACP pipe at /api/acp, which runs one harness for this connection. One connection, one session.

export interface AgentHandlers {
	onUpdate(params: acp.SessionNotification): void
	/** Resolves with the researcher's choice, or `{outcome: {outcome: 'cancelled'}}`. */
	onPermission(params: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse>
	/** The socket closed after the session started: the harness exited, idled out, or the server went away. */
	onClose(reason: string): void
}

export interface AgentConnection {
	sessionId: string
	agentInfo: acp.Implementation | null
	prompt(blocks: acp.ContentBlock[]): Promise<acp.PromptResponse>
	/** Sends session/cancel; the running prompt then resolves with stop reason `cancelled`. */
	cancel(): Promise<void>
	close(): void
}

export interface OpenAgentOptions {
	boardId: string
	memberId: string
	handlers: AgentHandlers
	/** The board service's origin; the page's own by default (tests pass theirs). */
	origin?: string
	/** The browser's WebSocket by default (tests pass the `ws` package's). */
	WebSocket?: typeof globalThis.WebSocket
}

export async function openAgentConnection({
	boardId,
	memberId,
	handlers,
	origin = location.origin,
	WebSocket: BaseWebSocket = globalThis.WebSocket,
}: OpenAgentOptions): Promise<AgentConnection> {
	const query = `board=${encodeURIComponent(boardId)}&member=${encodeURIComponent(memberId)}`
	// The SDK's stream doesn't say why a socket closed, so watch for it: the pipe's close reason
	// ("harness not found: set HARNESS_CMD", "idle timeout", …) is what the banner shows.
	let opened = false
	let closeReason = ''
	const TrackedWebSocket = function (url: string, protocols?: string | string[]) {
		const socket = new BaseWebSocket(url, protocols)
		socket.addEventListener('open', () => (opened = true))
		socket.addEventListener('close', (e) => (closeReason = e.reason || (e.code === 1000 ? 'closed' : `code ${e.code}`)))
		return socket
	} as unknown as WebSocketConstructor
	const describeClose = () =>
		opened ? closeReason || 'closed' : "couldn't start a chat: the server may be offline or running too many chats"

	const stream = createWebSocketStream(`${origin.replace(/^http/, 'ws')}/api/acp?${query}`, { WebSocket: TrackedWebSocket })
	const connection = acp
		.client({ name: 'paper-canvas' })
		.onRequest(acp.methods.client.session.requestPermission, (ctx) => handlers.onPermission(ctx.params, ctx.signal))
		.onNotification(acp.methods.client.session.update, (ctx) => handlers.onUpdate(ctx.params))
		// per-viewer canvas actions (T06): they move only this browser's view
		.onNotification(CANVAS_METHODS.focus, focusParams, ({ params: { sessionId: _, ...p } }) =>
			viewerBus.emit('focus', { ...p, from: 'agent' })
		)
		.onNotification(CANVAS_METHODS.highlight, highlightParams, ({ params: { sessionId: _, ...p } }) =>
			viewerBus.emit('highlight', p)
		)
		.onNotification(CANVAS_METHODS.openPaper, openPaperParams, ({ params }) =>
			viewerBus.emit('open_paper', { paperId: params.paperId, from: 'agent' })
		)
		.onNotification(CANVAS_METHODS.tour, tourParams, ({ params: { sessionId: _, ...p } }) =>
			viewerBus.emit('tour', { ...p, from: 'agent' })
		)
		// the agent looks at the board (T07): a PNG of this viewer's page, or an error it can explain
		.onRequest(CANVAS_METHODS.snapshot, snapshotParams, async ({ params: { sessionId: _, ...request } }) => {
			try {
				return await takeSnapshot(request)
			} catch (e) {
				throw new acp.RequestError(-32000, e instanceof Error ? e.message : String(e))
			}
		})
		.connect(stream)

	let sessionId: string
	let agentInfo: acp.Implementation | null
	try {
		const init = await connection.agent.request(acp.methods.agent.initialize, {
			protocolVersion: acp.PROTOCOL_VERSION,
			// no fs and no terminal: the agent can't touch files on this machine
			clientCapabilities: {},
			clientInfo: { name: 'paper-canvas', version: '0.0.0' },
		})
		agentInfo = init.agentInfo ?? null
		const session = await connection.agent.request(acp.methods.agent.session.new, {
			cwd: '/',
			// only the canvas MCP; the harness adds the papers MCP itself (group README, Shared contracts)
			mcpServers: [
				{
					type: 'http',
					name: 'canvas',
					url: `${origin}/api/mcp/canvas/${encodeURIComponent(boardId)}`,
					headers: [{ name: 'Authorization', value: `Bearer ${memberId}` }],
				},
			],
		})
		sessionId = session.sessionId
	} catch (e) {
		const closed = connection.signal.aborted
		connection.close()
		throw closed ? new Error(describeClose()) : e
	}
	void connection.closed.then(() => handlers.onClose(describeClose()))

	return {
		sessionId,
		agentInfo,
		prompt: (prompt) => connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt }),
		cancel: () => connection.agent.notify(acp.methods.agent.session.cancel, { sessionId }),
		close: () => connection.close(),
	}
}
