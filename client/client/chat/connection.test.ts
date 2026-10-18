import type { SessionNotification } from '@agentclientprotocol/sdk'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { handleAcpUpgrade } from '../../server/acpPipe.ts'
import { chatReducer, initialChatState, type ToolItem } from './chatState.ts'
import { openAgentConnection, type AgentHandlers } from './connection.ts'
import { viewerBus, type ViewerEvents } from './viewerBus.ts'

// The browser's ACP client end to end through the real pipe, with Node's built-in (browser-style)
// WebSocket and the fake harness from the pipe tests standing in for `python -m harness`.
const FAKE = `${process.execPath} ${fileURLToPath(new URL('../../server/fixtures/fakeHarness.ts', import.meta.url))}`

let server: Server
let origin = ''
const realLog = { log: console.log, warn: console.warn, error: console.error }

before(async () => {
	for (const k of ['log', 'warn', 'error'] as const) console[k] = () => {} // the pipe's harness logs
	server = createServer((_req, res) => res.end())
	server.on('upgrade', handleAcpUpgrade)
	server.listen(0)
	await once(server, 'listening')
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(() => {
	Object.assign(console, realLog)
	server.close()
})

beforeEach(() => {
	process.env.HARNESS_CMD = FAKE
})

function open() {
	const updates: SessionNotification[] = []
	const closes: string[] = []
	const handlers: AgentHandlers = {
		onUpdate: (n) => void updates.push(n),
		onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
		onClose: (reason) => void closes.push(reason),
	}
	const opening = openAgentConnection({ boardId: 'demo', memberId: 'm_test000000', handlers, origin })
	return { opening, updates, closes }
}

function collect<K extends keyof ViewerEvents>(type: K) {
	const seen: ViewerEvents[K][] = []
	const off = viewerBus.on(type, (p) => void seen.push(p))
	return { seen, off }
}

test('initialize, session/new with the canvas MCP, and a streamed prompt turn', async () => {
	const { opening, updates } = open()
	const conn = await opening
	assert.equal(conn.sessionId, 's_fake00000000')
	assert.equal(conn.agentInfo?.name, 'fake-harness')

	const focus = collect('focus')
	const res = await conn.prompt([{ type: 'text', text: 'hello board' }])
	focus.off()
	assert.equal(res.stopReason, 'end_turn')
	assert.deepEqual(res._meta?.mcpServers, [
		{
			type: 'http',
			name: 'canvas',
			url: `${origin}/api/mcp/canvas/demo`,
			headers: [{ name: 'Authorization', value: 'Bearer m_test000000' }],
		},
	])
	// _canvas/focus reaches the viewer bus without its sessionId
	assert.deepEqual(focus.seen, [{ paperIds: ['pmid:1'] }])

	let state = chatReducer(initialChatState, { type: 'send', text: 'hello board' })
	for (const n of updates) state = chatReducer(state, { type: 'update', update: n.update })
	const turn = state.turns[0]
	assert.deepEqual(
		turn.items.map((i) => i.kind),
		['thought', 'tool', 'message']
	)
	assert.equal((turn.items[1] as ToolItem).status, 'completed')
	assert.equal(turn.items[2].kind === 'message' && turn.items[2].text, 'hello board')
	assert.equal(turn.plan?.length, 2)
	assert.equal(state.usage?.used, 1200)
	conn.close()
})

test('_canvas/snapshot gets a "not supported yet" error', async () => {
	const { opening, updates } = open()
	const conn = await opening
	await conn.prompt([{ type: 'text', text: 'snapshot please' }])
	const text = updates.map((n) => (n.update.sessionUpdate === 'agent_message_chunk' && n.update.content.type === 'text' ? n.update.content.text : '')).join('')
	assert.match(text, /^snapshot: Snapshots are not supported yet\./)
	conn.close()
})

test('cancel ends the running prompt with stop reason cancelled', async () => {
	const { opening } = open()
	const conn = await opening
	const running = conn.prompt([{ type: 'text', text: 'wait for it' }])
	await new Promise((r) => setTimeout(r, 100))
	await conn.cancel()
	assert.equal((await running).stopReason, 'cancelled')
	conn.close()
})

test('a harness that dies closes the connection with its reason', async () => {
	const { opening, closes } = open()
	const conn = await opening
	await assert.rejects(conn.prompt([{ type: 'text', text: 'crash' }]))
	await new Promise((r) => setTimeout(r, 50))
	assert.deepEqual(closes, ['harness exited with code 3'])
})

test('a missing harness command fails the open with the pipe\'s hint', async () => {
	process.env.HARNESS_CMD = '/nonexistent/harness'
	const { opening } = open()
	await assert.rejects(opening, { message: 'harness not found: set HARNESS_CMD' })
})
