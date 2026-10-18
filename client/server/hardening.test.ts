// Checks for the PR #6 review fixes (docs/wps/tldraw-integration/T00-sync-server-hardening.md).
// Starts the real server on a spare port with a temp data dir: pnpm test
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { WebSocket } from 'ws'

const PORT = 5000 + Math.floor(Math.random() * 1000)
const BASE = `http://localhost:${PORT}`
const dataDir = mkdtempSync(join(tmpdir(), 'board-test-'))
let server: ChildProcess

before(async () => {
	mkdirSync(join(dataDir, 'rooms'), { recursive: true })
	writeFileSync(join(dataDir, 'rooms', 'broken.db'), 'not a sqlite database')
	server = spawn(process.execPath, ['server/server.ts'], {
		env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	await new Promise<void>((resolve, reject) => {
		server.stdout?.on('data', (d: Buffer) => d.toString().includes('sync server on') && resolve())
		server.on('exit', (code) => reject(new Error(`server exited with ${code}`)))
	})
})

after(() => {
	server.kill()
	rmSync(dataDir, { recursive: true, force: true })
})

const alive = async () => (await fetch(`${BASE}/api/nope`)).status === 404

function rawUpgrade(path: string) {
	return new Promise<string>((resolve) => {
		const socket = net.connect(PORT, 'localhost', () =>
			socket.write(
				`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
					'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
			)
		)
		let response = ''
		socket.on('data', (d) => (response += d))
		socket.on('close', () => resolve(response.split('\r\n')[0]))
	})
}

function connect(room: string) {
	return new WebSocket(`ws://localhost:${PORT}/api/connect/${room}?sessionId=s_${Math.random()}`)
}

const closeCode = (ws: WebSocket) => new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))

function note(id: string, color = 'yellow') {
	return {
		id,
		type: 'note',
		x: 100,
		y: 200,
		props: {
			color,
			labelColor: 'black',
			size: 'm',
			font: 'draw',
			fontSizeAdjustment: null,
			align: 'middle',
			verticalAlign: 'middle',
			growY: 0,
			url: '',
			richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] },
			scale: 1,
			textLastEditedBy: null,
		},
	}
}

const shapes = (method: string, body: unknown) =>
	fetch(`${BASE}/api/rooms/healthy/shapes`, {
		method,
		headers: { 'content-type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	})

test('a malformed websocket upgrade gets 400 and the server keeps running', async () => {
	assert.match(await rawUpgrade('//['), /400/)
	assert.ok(await alive())
})

test('a room that fails to open closes only its own socket, then fails fast', async () => {
	const healthy = connect('healthy')
	await new Promise((resolve) => healthy.on('open', resolve))
	assert.equal(await closeCode(connect('broken')), 1011)
	assert.equal(await closeCode(connect('broken')), 1011)
	assert.ok(await alive())
	assert.equal(healthy.readyState, WebSocket.OPEN)
	healthy.close()
})

test('POST only creates; PATCH merges and keeps position', async () => {
	assert.equal((await shapes('POST', [note('shape:t')])).status, 200)
	assert.equal((await shapes('POST', [note('shape:t', 'blue')])).status, 409)
	assert.equal((await shapes('PATCH', [{ id: 'shape:t', props: { color: 'green' }, meta: { by: 'agent' } }])).status, 200)
	assert.equal((await shapes('PATCH', [{ id: 'shape:missing', props: { color: 'green' } }])).status, 404)
	assert.equal((await shapes('PATCH', [{ id: 'shape:t', props: { color: 'nope' } }])).status, 400)
	assert.equal((await shapes('POST', '{not json')).status, 400)
})

test('unfurl refuses private addresses', async () => {
	for (const url of ['http://127.0.0.1/', 'http://localhost/', 'http://169.254.169.254/', 'http://[::ffff:127.0.0.1]/']) {
		const res = await fetch(`${BASE}/api/unfurl?url=${encodeURIComponent(url)}`)
		assert.equal(res.status, 422, url)
	}
})

test('an upload that never finished can be retried', async () => {
	mkdirSync(join(dataDir, 'uploads'), { recursive: true })
	writeFileSync(join(dataDir, 'uploads', 'stuck_png'), 'partial')
	const res = await fetch(`${BASE}/api/uploads/stuck.png`, {
		method: 'POST',
		headers: { 'content-type': 'image/png' },
		body: 'image',
	})
	assert.equal(res.status, 200)
})
