// Rooms (T02): bindings through the REST route, the canvas MCP route on the real server, and
// rooms closing when only agents wrote to them. node --test server/rooms.test.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { TLRecord } from '@tldraw/tlschema'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { closeAllRooms, getRoom, IDLE_CLOSE_MS, isRoomOpen, putShapes, readRoom, setRoomsDir } from './rooms.ts'

const PORT = 6000 + Math.floor(Math.random() * 1000)
const BASE = `http://localhost:${PORT}`
const dataDir = mkdtempSync(join(tmpdir(), 'rooms-test-'))
let server: ChildProcess

before(async () => {
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
	closeAllRooms()
	rmSync(dataDir, { recursive: true, force: true })
})

const richText = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

const note = (id: string, x = 0) => ({
	id,
	type: 'note',
	x,
	y: 0,
	props: {
		color: 'yellow',
		labelColor: 'black',
		size: 'm',
		font: 'draw',
		fontSizeAdjustment: 1,
		align: 'middle',
		verticalAlign: 'middle',
		growY: 0,
		url: '',
		richText: richText('hi'),
		scale: 1,
		textLastEditedBy: null,
	},
})

const geo = (id: string, x: number) => ({
	id,
	type: 'geo',
	x,
	y: 0,
	props: {
		geo: 'rectangle',
		dash: 'draw',
		url: '',
		w: 100,
		h: 100,
		growY: 0,
		scale: 1,
		flipX: false,
		flipY: false,
		labelColor: 'black',
		color: 'black',
		fill: 'none',
		size: 'm',
		font: 'draw',
		align: 'middle',
		verticalAlign: 'middle',
		richText: richText(''),
	},
})

const arrow = {
	id: 'shape:arrow',
	type: 'arrow',
	x: 50,
	y: 50,
	props: {
		kind: 'arc',
		elbowMidPoint: 0.5,
		dash: 'draw',
		size: 'm',
		fill: 'none',
		color: 'black',
		labelColor: 'black',
		bend: 0,
		start: { x: 0, y: 0 },
		end: { x: 300, y: 0 },
		arrowheadStart: 'none',
		arrowheadEnd: 'arrow',
		richText: richText(''),
		labelPosition: 0.5,
		font: 'draw',
		scale: 1,
	},
}

const arrowBinding = (id: string, terminal: string, toId: string) => ({
	typeName: 'binding',
	id,
	type: 'arrow',
	fromId: 'shape:arrow',
	toId,
	props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' },
	meta: { by: 'seed' },
})

const post = (room: string, body: unknown) =>
	fetch(`${BASE}/api/rooms/${room}/shapes`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})

test('POST creates bindings with their shapes in one request, in any order', async () => {
	const res = await post('seed', [
		arrowBinding('binding:start', 'start', 'shape:a'),
		geo('shape:a', 0),
		geo('shape:b', 400),
		arrow,
		arrowBinding('binding:end', 'end', 'shape:b'),
		note('shape:n', 600),
		{ typeName: 'binding', id: 'binding:pin', type: 'note-pin', fromId: 'shape:n', toId: 'shape:b', props: { dx: 200, dy: 0 } },
	])
	assert.equal(res.status, 200)
	assert.deepEqual((await res.json()).ids, [
		'binding:start',
		'shape:a',
		'shape:b',
		'shape:arrow',
		'binding:end',
		'shape:n',
		'binding:pin',
	])
})

test('POST refuses an existing binding, a missing end and bad props, writing nothing', async () => {
	assert.equal((await post('seed', [arrowBinding('binding:start', 'start', 'shape:a')])).status, 409)
	assert.equal((await post('seed', [arrowBinding('binding:x', 'start', 'shape:missing')])).status, 400)
	assert.equal((await post('seed', [{ ...arrowBinding('binding:y', 'start', 'shape:a'), props: { terminal: 'middle' } }])).status, 400)
	assert.equal((await post('seed', [{ typeName: 'page', id: 'page:x' }])).status, 400)
	// one bad item fails the whole request, so the note before it isn't written either
	assert.equal((await post('seed', [note('shape:new'), arrowBinding('binding:z', 'end', 'shape:missing')])).status, 400)
	assert.equal((await post('seed', [note('shape:new')])).status, 200)
})

test('the canvas MCP route needs a member bearer and lists its tools', async () => {
	const res = await fetch(`${BASE}/api/mcp/canvas/seed`, { method: 'POST', body: '{}' })
	assert.equal(res.status, 401)
	const client = new Client({ name: 'test', version: '0' })
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp/canvas/seed`), {
			requestInit: { headers: { Authorization: 'Bearer m_test' } },
		})
	)
	assert.equal((await client.listTools()).tools.length, 8)
	await client.close()
})

test('what the REST route wrote is in the room file', async () => {
	server.kill()
	await new Promise((resolve) => server.once('exit', resolve))
	setRoomsDir(join(dataDir, 'rooms'))
	const records = readRoom('seed', (txn) => [...txn.values()]) as TLRecord[]
	const pin = records.find((r) => r.id === 'binding:pin')
	assert.equal(pin?.typeName === 'binding' && pin.type, 'note-pin')
	assert.equal(records.filter((r) => r.typeName === 'binding' && r.type === 'arrow').length, 2)
	closeAllRooms()
})

test('a room opened only by writes closes 30 s after the last one; a connection keeps it open', (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	setRoomsDir(join(dataDir, 'idle'))
	putShapes('idle', [note('shape:a')])
	assert.ok(isRoomOpen('idle'))
	t.mock.timers.tick(IDLE_CLOSE_MS - 1000)
	putShapes('idle', [note('shape:b')])
	t.mock.timers.tick(IDLE_CLOSE_MS - 1000)
	assert.ok(isRoomOpen('idle'), 'a write restarts the wait')
	t.mock.timers.tick(1000)
	assert.equal(isRoomOpen('idle'), false)

	putShapes('watched', [note('shape:a')])
	const socket = { send() {}, close() {}, readyState: 1, addEventListener() {}, removeEventListener() {} }
	getRoom('watched').handleSocketConnect({ sessionId: 's1', socket })
	t.mock.timers.tick(IDLE_CLOSE_MS + 1000)
	assert.ok(isRoomOpen('watched'))
	closeAllRooms()
})
