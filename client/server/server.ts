import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import { createTLSchema, defaultShapeSchemas, type TLRecord, type TLShape } from '@tldraw/tlschema'
import { getIndexAbove, type IndexKey } from '@tldraw/utils'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pipeline } from 'node:stream/promises'
import { unfurl } from 'unfurl.js'
import { WebSocketServer } from 'ws'

// The sync server: one TLSocketRoom per room, each saved to its own SQLite file under DATA_DIR,
// plus asset uploads on local disk, bookmark unfurling, and the built frontend from dist/.
const PORT = Number(process.env.PORT ?? 5858)
const DATA_DIR = resolve(process.env.DATA_DIR ?? '.data')
const ROOMS_DIR = join(DATA_DIR, 'rooms')
const UPLOADS_DIR = join(DATA_DIR, 'uploads')
const DIST_DIR = resolve('dist')
mkdirSync(ROOMS_DIR, { recursive: true })
mkdirSync(UPLOADS_DIR, { recursive: true })

// add custom shapes and bindings here if needed:
const schema = createTLSchema({
	shapes: { ...defaultShapeSchemas },
	// bindings: { ...defaultBindingSchemas },
})

// room and upload ids come from URLs, so strip anything that could escape the data dir
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]+/g, '_')

const rooms = new Map<string, TLSocketRoom<TLRecord, void>>()

function getRoom(roomId: string) {
	const id = safeId(roomId)
	let room = rooms.get(id)
	if (room) return room

	const db = new DatabaseSync(join(ROOMS_DIR, `${id}.db`))
	room = new TLSocketRoom<TLRecord, void>({
		schema,
		storage: new SQLiteSyncStorage<TLRecord>({ sql: new NodeSqliteWrapper(db) }),
		// every change is already in SQLite, so the room can close when the last client leaves
		onSessionRemoved(room, { numSessionsRemaining }) {
			if (numSessionsRemaining > 0) return
			room.close()
			db.close()
			rooms.delete(id)
		},
	})
	rooms.set(id, room)
	return room
}

// Write shapes into a room from the server; connected clients see them live. Each shape needs
// `type` and full `props`. The page, stacking order and (unless given) id are filled in, and an
// existing id is overwritten. Throws without writing anything if any shape is invalid.
function putShapes(roomId: string, shapes: Partial<TLShape>[]) {
	return getRoom(roomId).storage.transaction((txn) => {
		const records = [...txn.values()]
		const pageId = records
			.filter((r) => r.typeName === 'page')
			.sort((a, b) => (a.index < b.index ? -1 : 1))[0]?.id
		let index = records.reduce<IndexKey | null>(
			(max, r) => (r.typeName === 'shape' && (!max || r.index > max) ? r.index : max),
			null
		)
		return shapes.map((partial) => {
			index = getIndexAbove(index)
			const shape = schema.types.shape.validate(
				schema.types.shape.create({ parentId: pageId, ...partial, index } as TLShape)
			)
			txn.set(shape.id, shape)
			return shape.id
		})
	}).result
}

function send(res: ServerResponse, status: number, body: string) {
	if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/plain' })
	res.end(body)
}

function sendJson(res: ServerResponse, body: unknown) {
	res.writeHead(200, { 'content-type': 'application/json' })
	res.end(JSON.stringify(body))
}

// we only allow image and video uploads. the content type is kept next to the file.
async function handleUpload(uploadId: string, req: IncomingMessage, res: ServerResponse) {
	const contentType = req.headers['content-type'] ?? ''
	if (!contentType.startsWith('image/') && !contentType.startsWith('video/')) {
		return send(res, 400, 'Invalid content type')
	}
	const file = join(UPLOADS_DIR, safeId(uploadId))
	try {
		await pipeline(req, createWriteStream(file, { flags: 'wx' }))
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'EEXIST') return send(res, 409, 'Upload already exists')
		rmSync(file, { force: true })
		throw e
	}
	writeFileSync(`${file}.type`, contentType)
	sendJson(res, { ok: true })
}

// ponytail: no Range support, so videos can't seek before they've fully loaded
async function handleDownload(uploadId: string, res: ServerResponse) {
	const file = join(UPLOADS_DIR, safeId(uploadId))
	// the .type file is written last, so this only serves finished uploads
	if (!existsSync(`${file}.type`)) return send(res, 404, 'Not found')
	res.writeHead(200, {
		'content-type': readFileSync(`${file}.type`, 'utf8'),
		// assets are immutable, so we can cache them basically forever:
		'cache-control': 'public, max-age=31536000, immutable',
		'access-control-allow-origin': '*',
		// Prevent XSS from user-uploaded SVGs (or any file served with an executable content-type).
		'content-security-policy': "default-src 'none'",
		'x-content-type-options': 'nosniff',
	})
	await pipeline(createReadStream(file), res)
}

// bookmarks need to extract metadata from pasted URLs
async function handleUnfurl(url: string | null, res: ServerResponse) {
	if (!url?.match(/^https?:\/\//)) return send(res, 400, 'Bad URL query parameter.')
	try {
		const { title, description, favicon, open_graph, twitter_card } = await unfurl(url, { timeout: 5000 })
		const ogImage = open_graph?.images?.[0]
		sendJson(res, {
			title,
			description,
			favicon,
			image: ogImage?.url ?? twitter_card?.images?.[0]?.url,
			imageWidth: ogImage?.width,
			imageHeight: ogImage?.height,
		})
	} catch {
		send(res, 422, 'Failed to fetch URL.')
	}
}

const MIME: Record<string, string> = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
}

// the built frontend; unknown paths get index.html so client-side routes like /:roomId work
async function handleStatic(pathname: string, res: ServerResponse) {
	let file = join(DIST_DIR, decodeURIComponent(pathname))
	if (!file.startsWith(DIST_DIR + sep) || !existsSync(file) || statSync(file).isDirectory()) {
		file = join(DIST_DIR, 'index.html')
	}
	if (!existsSync(file)) return send(res, 404, 'No frontend build found. Run `pnpm build` first.')
	res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
	await pipeline(createReadStream(file), res)
}

const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url ?? '/', 'http://localhost')
		const path = url.pathname
		let m: RegExpMatchArray | null

		if ((m = path.match(/^\/api\/uploads\/([^/]+)$/))) {
			if (req.method === 'POST') return await handleUpload(m[1], req, res)
			if (req.method === 'GET') return await handleDownload(m[1], res)
		}
		if (req.method === 'GET' && path === '/api/unfurl') {
			return await handleUnfurl(url.searchParams.get('url'), res)
		}
		if (req.method === 'POST' && (m = path.match(/^\/api\/rooms\/([^/]+)\/shapes$/))) {
			try {
				const shapes = JSON.parse(Buffer.concat(await req.toArray()).toString())
				return sendJson(res, { ids: putShapes(m[1], shapes) })
			} catch (e) {
				return send(res, 400, String(e))
			}
		}
		if (path.startsWith('/api/')) return send(res, 404, 'Not found')
		await handleStatic(path, res)
	} catch (e) {
		console.error(e)
		send(res, 500, 'Internal error')
	}
})

// realtime sync: the client opens a websocket at /api/connect/:roomId?sessionId=...
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
	const url = new URL(req.url ?? '/', 'http://localhost')
	const roomId = url.pathname.match(/^\/api\/connect\/([^/]+)$/)?.[1]
	const sessionId = url.searchParams.get('sessionId')
	if (!roomId || !sessionId) return socket.destroy()
	wss.handleUpgrade(req, socket, head, (ws) => {
		getRoom(roomId).handleSocketConnect({ sessionId, socket: ws })
	})
})

server.listen(PORT, () => console.log(`sync server on http://localhost:${PORT}, data in ${DATA_DIR}`))
