import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { handleAcpUpgrade, isAgentActive, onAgentPresence, shutdownAcpPipe } from './acpPipe.ts'

// The pipe on a bare HTTP server (no server.ts), with a tiny Node script as the harness.
// HARNESS_CMD is split on spaces, so this assumes no spaces in the node or repo path.
const FAKE = `${process.execPath} ${fileURLToPath(new URL('./fixtures/fakeHarness.ts', import.meta.url))}`

let server: Server
let base = ''
const logs: string[] = []
const realLog = { log: console.log, warn: console.warn, error: console.error }

before(async () => {
	for (const k of ['log', 'warn', 'error'] as const) console[k] = (...a: unknown[]) => void logs.push(a.join(' '))
	server = createServer((_req, res) => res.end())
	server.on('upgrade', handleAcpUpgrade)
	server.listen(0)
	await once(server, 'listening')
	base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/acp`
})

after(() => {
	Object.assign(console, realLog)
	server.close()
})

beforeEach(() => {
	process.env.HARNESS_CMD = FAKE
	process.env.PORT = '5999'
	delete process.env.FAKE_HARNESS
	delete process.env.MAX_HARNESSES
	delete process.env.HARNESS_IDLE_MINUTES
	logs.length = 0
})

const url = (board = 'demo', member = 'm_test000000') => `${base}?board=${board}&member=${member}`

/** Opens a chat and collects every frame it receives, parsed. */
async function connect(target = url()) {
	const ws = new WebSocket(target)
	const frames: any[] = []
	const waiters: { test: (f: any) => boolean; resolve: (f: any) => void }[] = []
	ws.on('message', (data, isBinary) => {
		assert.equal(isBinary, false)
		const frame = JSON.parse(data.toString())
		frames.push(frame)
		for (const w of [...waiters]) if (w.test(frame)) waiters.splice(waiters.indexOf(w), 1), w.resolve(frame)
	})
	const closed = new Promise<{ code: number; reason: string }>((resolve) =>
		ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
	)
	await once(ws, 'open')
	const next = (test: (f: any) => boolean) =>
		new Promise<any>((resolve) => {
			const found = frames.find(test)
			if (found) return resolve(found)
			waiters.push({ test, resolve })
		})
	const call = (method: string, params?: unknown, id: unknown = method) => {
		ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
		return next((f) => f.id === id)
	}
	return { ws, frames, next, call, closed }
}

function status(target: string) {
	return new Promise<number>((resolve, reject) => {
		const ws = new WebSocket(target)
		ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
		ws.on('open', () => reject(new Error('upgrade accepted')))
		ws.on('error', () => {})
	})
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

async function waitUntil(check: () => boolean, ms: number) {
	const start = Date.now()
	while (!check()) {
		if (Date.now() - start > ms) throw new Error(`still waiting after ${ms} ms`)
		await new Promise((r) => setTimeout(r, 50))
	}
	return Date.now() - start
}

test('refuses a missing or malformed board or member with 400', async () => {
	assert.equal(await status(`${base}?member=m_test000000`), 400)
	assert.equal(await status(`${base}?board=demo`), 400)
	assert.equal(await status(url('../etc', 'm_test000000')), 400)
	assert.equal(await status(url('demo', 'test000000')), 400)
	assert.equal(await status(url('demo', 'm_')), 400)
})

test('frames both ways, with the server environment plus the board and member', async () => {
	const chat = await connect()
	// a pretty-printed frame reaches the harness as one line
	chat.ws.send('{\n  "jsonrpc": "2.0",\n  "id": 1,\n  "method": "env"\n}')
	const { result } = await chat.next((f) => f.id === 1)
	assert.equal(result.line, '{"jsonrpc":"2.0","id":1,"method":"env"}')
	assert.deepEqual(result.env, {
		BOARD_ID: 'demo',
		MEMBER_ID: 'm_test000000',
		BOARD_INTERNAL_URL: 'http://127.0.0.1:5999',
		PYTHONUNBUFFERED: '1',
	})
	// arrays (JSON-RPC batches) pass through too
	chat.ws.send(JSON.stringify([{ jsonrpc: '2.0', method: 'hello' }]))
	const echo = await chat.next((f) => f.method === 'echo')
	assert.deepEqual(echo.params.message, [{ jsonrpc: '2.0', method: 'hello' }])
	chat.ws.close()
	await waitUntil(() => !alive(result.pid), 3000)
	assert.ok(logs.some((l) => l.includes(`[harness demo/m_test000000 ${result.pid}] fake harness ready`)), 'stderr is logged')
})

test("drops harness output that isn't a JSON object or array, and logs it", async () => {
	const chat = await connect()
	await chat.call('env')
	// the banner and the bare 42 came before the reply, yet only the reply arrived
	assert.deepEqual(chat.frames.map((f) => f.id), ['env'])
	assert.ok(logs.some((l) => l.includes('protocol violation') && l.includes('banner: this line is not JSON')))
	assert.ok(logs.some((l) => l.includes('protocol violation') && l.endsWith('42')))
	chat.ws.close()
	await chat.closed
})

test('answers frames that are binary or not a JSON object with a parse error, and keeps going', async () => {
	const chat = await connect()
	chat.ws.send('not json')
	chat.ws.send('"just a string"')
	chat.ws.send(Buffer.from('{"id":1}'), { binary: true })
	await waitUntil(() => chat.frames.filter((f) => f.error?.code === -32700).length === 3, 2000)
	const { result } = await chat.call('env')
	assert.ok(result.pid)
	chat.ws.close()
	await chat.closed
})

test('closing the socket ends the harness: on stdin end, else SIGTERM at 2 s, else SIGKILL at 5 s', async () => {
	const pids: number[] = []
	const chats = []
	for (const mode of ['', 'ignore-eof', 'ignore-eof ignore-term']) {
		process.env.FAKE_HARNESS = mode
		const chat = await connect()
		pids.push((await chat.call('env')).result.pid)
		chats.push(chat)
	}
	const start = Date.now()
	chats.forEach((c) => c.ws.close())
	const gone = await Promise.all(pids.map((pid) => waitUntil(() => !alive(pid), 7000).then(() => Date.now() - start)))
	assert.ok(gone[0] < 1500, `exits on stdin end (${gone[0]} ms)`)
	assert.ok(gone[1] >= 1900 && gone[1] < 4000, `SIGTERM after 2 s (${gone[1]} ms)`)
	assert.ok(gone[2] >= 4900 && gone[2] < 6500, `SIGKILL after 5 s (${gone[2]} ms)`)
})

test('closes the socket with 1000 when the harness exits cleanly, 1011 otherwise', async () => {
	const ok = await connect()
	ok.ws.send(JSON.stringify({ method: 'exit', params: { code: 0 } }))
	assert.equal((await ok.closed).code, 1000)
	const bad = await connect()
	bad.ws.send(JSON.stringify({ method: 'exit', params: { code: 3 } }))
	assert.deepEqual(await bad.closed, { code: 1011, reason: 'harness exited with code 3' })
})

test('refuses the chat above MAX_HARNESSES with 503, and frees the slot when one ends', async () => {
	process.env.MAX_HARNESSES = '2'
	const a = await connect()
	const b = await connect(url('other', 'm_test111111'))
	assert.equal(await status(url()), 503)
	a.ws.close()
	await a.closed
	await waitUntil(() => !logs.every((l) => !l.includes('exited')), 3000)
	const c = await connect()
	assert.ok((await c.call('env')).result.pid)
	b.ws.close()
	c.ws.close()
	await Promise.all([b.closed, c.closed])
})

test('closes with 1011 and a hint when the harness command is missing', async () => {
	process.env.HARNESS_CMD = '/nonexistent/harness --flag'
	const chat = await connect()
	assert.deepEqual(await chat.closed, { code: 1011, reason: 'harness not found: set HARNESS_CMD' })
	assert.ok(logs.some((l) => l.includes('/nonexistent/harness --flag')), 'logs the command')
})

test('closes an idle chat, which ends its harness', async () => {
	process.env.HARNESS_IDLE_MINUTES = String(0.4 / 60)
	const chat = await connect()
	const { result } = await chat.call('env')
	assert.deepEqual(await chat.closed, { code: 1000, reason: 'idle timeout' })
	await waitUntil(() => !alive(result.pid), 2000)
})

test('pauses the harness while the browser is slow, without losing or reordering frames', async () => {
	const chat = await connect()
	await chat.call('env')
	// stop reading on the browser side so the server's send buffer fills past 1 MB
	const socket = (chat.ws as any)._socket
	socket.pause()
	chat.ws.send(JSON.stringify({ method: 'flood', params: { count: 400, size: 16_000 } }))
	await new Promise((r) => setTimeout(r, 500))
	socket.resume()
	await waitUntil(() => chat.frames.filter((f) => f.method === 'flood').length === 400, 10_000)
	const order = chat.frames.filter((f) => f.method === 'flood').map((f) => f.params.i)
	assert.deepEqual(order, [...Array(400).keys()])
	chat.ws.close()
	await chat.closed
})

test('tells the board service when a board gets its first harness and loses its last', async () => {
	const heard: [string, boolean][] = []
	// harnesses from earlier tests may still be exiting, so only this board counts
	onAgentPresence((board, active) => board === 'presence' && heard.push([board, active]))
	const chats = [await connect(url('presence', 'm_test000000')), await connect(url('presence', 'm_test111111'))]
	await Promise.all(chats.map((c) => c.call('env')))
	assert.deepEqual(heard, [['presence', true]])
	assert.equal(isAgentActive('presence'), true)
	for (const c of chats) c.ws.close()
	await waitUntil(() => heard.length === 2, 5000)
	assert.deepEqual(heard, [['presence', true], ['presence', false]])
	assert.equal(isAgentActive('presence'), false)
	onAgentPresence(() => {})
})

test('shutting down closes every chat with 1001 and waits for the harnesses', async () => {
	const chats = [await connect(), await connect(url('other', 'm_test111111'))]
	const pids = await Promise.all(chats.map(async (c) => (await c.call('env')).result.pid))
	await shutdownAcpPipe()
	assert.ok(pids.every((pid) => !alive(pid)))
	for (const c of chats) assert.deepEqual(await c.closed, { code: 1001, reason: 'server shutting down' })
})
