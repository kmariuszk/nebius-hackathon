import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { unfurl } from 'unfurl.js'
import { WebSocketServer } from 'ws'
import { handleAcpUpgrade } from './acpPipe.ts'
import { handleCanvasMcp } from './canvasMcp.ts'
import { publicFetch } from './netGuard.ts'
import { getRoom, HttpError, patchShapes, putShapes, safeId } from './rooms.ts'

// The sync server: one TLSocketRoom per room (rooms.ts), each saved to its own SQLite file under
// DATA_DIR, plus the canvas MCP, asset uploads on local disk, bookmark unfurling, and the built
// frontend from dist/.
const PORT = Number(process.env.PORT ?? 5858)
const DATA_DIR = resolve(process.env.DATA_DIR ?? '.data')
const UPLOADS_DIR = join(DATA_DIR, 'uploads')
const DIST_DIR = resolve('dist')
mkdirSync(UPLOADS_DIR, { recursive: true })

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
	// a file without its .type marker is a leftover from an upload that never finished
	if (existsSync(file) && !existsSync(`${file}.type`)) rmSync(file, { force: true })
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

// bookmarks need to extract metadata from pasted URLs. Every fetch (the page and its oEmbed
// link) goes through publicFetch, so a pasted URL can't make the server call a private address.
const UNFURL_HEADERS = { Accept: 'text/html, application/xhtml+xml', 'User-Agent': 'facebookexternalhit' }

async function handleUnfurl(url: string | null, res: ServerResponse) {
	if (!url?.match(/^https?:\/\//)) return send(res, 400, 'Bad URL query parameter.')
	try {
		const { title, description, favicon, open_graph, twitter_card } = await unfurl(url, {
			fetch: (target) => publicFetch(target, { headers: UNFURL_HEADERS }),
		})
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

// Bad input is the client's fault (400 with the reason); anything else is ours (500, logged).
async function handleShapes(roomId: string, req: IncomingMessage, res: ServerResponse) {
	try {
		const body = JSON.parse(Buffer.concat(await req.toArray()).toString())
		if (!Array.isArray(body)) throw new HttpError(400, 'Expected a JSON array of shapes and bindings')
		return sendJson(res, { ids: req.method === 'PATCH' ? patchShapes(roomId, body) : putShapes(roomId, body) })
	} catch (e) {
		if (e instanceof HttpError) return send(res, e.status, e.message)
		if (e instanceof SyntaxError || (e instanceof Error && e.name === 'ValidationError')) {
			return send(res, 400, String(e))
		}
		console.error(e)
		return send(res, 500, 'Internal error')
	}
}

function parseUrl(raw: string | undefined) {
	try {
		return new URL(raw ?? '/', 'http://localhost')
	} catch {
		return null
	}
}

const server = createServer(async (req, res) => {
	try {
		const url = parseUrl(req.url)
		if (!url) return send(res, 400, 'Bad request')
		const path = url.pathname
		let m: RegExpMatchArray | null

		if ((m = path.match(/^\/api\/uploads\/([^/]+)$/))) {
			if (req.method === 'POST') return await handleUpload(m[1], req, res)
			if (req.method === 'GET') return await handleDownload(m[1], res)
		}
		if (req.method === 'GET' && path === '/api/unfurl') {
			return await handleUnfurl(url.searchParams.get('url'), res)
		}
		if ((req.method === 'POST' || req.method === 'PATCH') && (m = path.match(/^\/api\/rooms\/([^/]+)\/shapes$/))) {
			return await handleShapes(m[1], req, res)
		}
		if ((m = path.match(/^\/api\/mcp\/canvas\/([^/]+)$/))) return await handleCanvasMcp(req, res, m[1])
		if (path.startsWith('/api/')) return send(res, 404, 'Not found')
		await handleStatic(path, res)
	} catch (e) {
		console.error(e)
		send(res, 500, 'Internal error')
	}
})

function rejectUpgrade(socket: Duplex, status: number, reason: string) {
	socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
	socket.destroy()
}

// realtime sync: the client opens a websocket at /api/connect/:roomId?sessionId=...
// Nothing here may throw: an uncaught error would take down every room on the server.
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
	try {
		const url = parseUrl(req.url)
		if (url?.pathname === '/api/acp') return handleAcpUpgrade(req, socket, head)
		const roomId = url?.pathname.match(/^\/api\/connect\/([^/]+)$/)?.[1]
		const sessionId = url?.searchParams.get('sessionId')
		if (!roomId || !sessionId) return rejectUpgrade(socket, 400, 'Bad Request')
		wss.handleUpgrade(req, socket, head, (ws) => {
			try {
				getRoom(roomId).handleSocketConnect({ sessionId, socket: ws })
			} catch (e) {
				console.error(`Room ${safeId(roomId)} could not be opened:`, e)
				ws.close(1011, 'Room unavailable')
			}
		})
	} catch (e) {
		console.error('Bad websocket upgrade:', e)
		rejectUpgrade(socket, 400, 'Bad Request')
	}
})

server.listen(PORT, () => console.log(`sync server on http://localhost:${PORT}, data in ${DATA_DIR}`))
