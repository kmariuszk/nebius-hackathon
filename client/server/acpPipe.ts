import { spawn, type ChildProcess } from 'node:child_process'
import type { IncomingMessage } from 'node:http'
import { createInterface } from 'node:readline'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'

// The ACP pipe (T03): one WebSocket at /api/acp?board=…&member=…, one harness process on stdio.
// Each text frame becomes one line on the harness's stdin and each JSON line on its stdout one
// frame. The pipe never parses ACP beyond "is this a JSON object or array", and it never leaves a
// harness running after its socket is gone.

const DEFAULT_CMD = 'uv run --project ../harness python -m harness'
const BOARD_ID = /^[a-zA-Z0-9_-]{1,128}$/
const MEMBER_ID = /^m_[a-zA-Z0-9_-]{1,64}$/
const HIGH_WATER = 1024 * 1024
const TERM_AFTER_MS = 2000
const KILL_AFTER_MS = 5000

// Read on every upgrade rather than at import, so tests can change them between chats.
function settings() {
	const env = process.env
	return {
		cmd: (env.HARNESS_CMD?.trim() || DEFAULT_CMD).split(/\s+/),
		idleMs: Number(env.HARNESS_IDLE_MINUTES || 10) * 60_000,
		max: Number(env.MAX_HARNESSES || 8),
		port: env.PORT || '5858',
	}
}

interface Harness {
	/** Closes the socket, ends stdin, then escalates to SIGTERM and SIGKILL; safe to call twice. */
	stop(code: number, reason: string): void
	closed: Promise<void>
}

// counts processes, not sockets: a harness that is still shutting down holds its slot
const live = new Set<Harness>()
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 })

// Harnesses per board, for the agent in the face pile (T08's agent.active and agent.idle events).
const perBoard = new Map<string, number>()
let presence: (board: string, active: boolean) => void = () => {}

/** `fn` hears when a board gets its first harness (true) and loses its last (false); it must not throw. */
export function onAgentPresence(fn: (board: string, active: boolean) => void) {
	presence = fn
}

export const isAgentActive = (board: string) => perBoard.has(board)

export function handleAcpUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
	const url = new URL(req.url ?? '/', 'http://localhost')
	const board = url.searchParams.get('board') ?? ''
	const member = url.searchParams.get('member') ?? ''
	if (!BOARD_ID.test(board) || !MEMBER_ID.test(member)) return reject(socket, 400, 'Bad Request')
	const config = settings()
	if (live.size >= config.max) {
		console.warn(`[acp] refused a chat on ${board}: ${live.size} harnesses running (MAX_HARNESSES=${config.max})`)
		return reject(socket, 503, 'Service Unavailable')
	}
	// ws completes the handshake synchronously here, so the count above can't race
	wss.handleUpgrade(req, socket, head, (ws) => startHarness(ws, board, member, config))
}

/** Closes every chat and waits up to 5 s for the harnesses to exit. */
export async function shutdownAcpPipe() {
	const all = [...live]
	for (const h of all) h.stop(1001, 'server shutting down')
	await Promise.race([Promise.all(all.map((h) => h.closed)), delay(KILL_AFTER_MS + 500)])
}

function startHarness(ws: WebSocket, board: string, member: string, config: ReturnType<typeof settings>) {
	hookSignals()
	const [command, ...args] = config.cmd
	const child = spawn(command, args, {
		env: {
			...process.env,
			BOARD_ID: board,
			MEMBER_ID: member,
			BOARD_INTERNAL_URL: `http://127.0.0.1:${config.port}`,
			PYTHONUNBUFFERED: '1',
		},
		stdio: ['pipe', 'pipe', 'pipe'],
		// its own process group, so the signals reach `uv run`'s python child too
		detached: true,
	})
	const tag = `[harness ${board}/${member} ${child.pid ?? '-'}]`
	console.log(`${tag} started: ${config.cmd.join(' ')}`)
	const out = createInterface({ input: child.stdout!, crlfDelay: Infinity })
	// newer Node (seen on 25) throws ERR_USE_AFTER_CLOSE from resume() once stdout has ended,
	// which happens whenever the harness exits before the socket closes
	let outClosed = false
	out.on('close', () => (outClosed = true))
	const resumeOut = () => outClosed || out.resume()
	const isOpen = () => ws.readyState === ws.CONNECTING || ws.readyState === ws.OPEN

	let exited = false
	let stopping = false
	let spawnError = ''
	let idleTimer: NodeJS.Timeout | undefined
	const killTimers: NodeJS.Timeout[] = []
	let markClosed = () => {}
	const harness: Harness = {
		closed: new Promise((resolve) => (markClosed = resolve)),
		stop(code, reason) {
			clearTimeout(idleTimer)
			if (isOpen()) ws.close(code, reason)
			resumeOut() // nobody reads any more: let the harness flush and exit
			if (stopping || exited) return
			stopping = true
			child.stdin?.end()
			killTimers.push(
				setTimeout(() => signal(child, 'SIGTERM'), TERM_AFTER_MS),
				setTimeout(() => signal(child, 'SIGKILL'), KILL_AFTER_MS)
			)
		},
	}
	live.add(harness)
	perBoard.set(board, (perBoard.get(board) ?? 0) + 1)
	if (perBoard.get(board) === 1) presence(board, true)

	const touch = () => {
		clearTimeout(idleTimer)
		idleTimer = setTimeout(() => {
			console.log(`${tag} idle for ${config.idleMs / 60_000} min, closing`)
			harness.stop(1000, 'idle timeout')
		}, config.idleMs)
	}
	touch()

	// browser to harness: one JSON value per frame, re-serialised so it can't contain a newline
	ws.on('message', (data, isBinary) => {
		touch()
		const value = isBinary ? undefined : parseJson(data.toString())
		if (value === undefined) {
			console.warn(`${tag} dropped a ${isBinary ? 'binary' : 'non-JSON'} frame from the browser`)
			const error = { code: -32700, message: 'Parse error: expected a JSON object or array' }
			ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error }))
			return
		}
		if (child.stdin?.writable) child.stdin.write(JSON.stringify(value) + '\n')
	})
	child.stdin?.on('error', (e) => console.warn(`${tag} stdin: ${e.message}`))

	// harness to browser: one frame per JSON line; anything else is stray output, logged and dropped
	let paused = false
	out.on('line', (line) => {
		if (!line.trim()) return
		if (parseJson(line) === undefined) {
			console.warn(`${tag} protocol violation, dropped a stdout line that isn't JSON: ${line.slice(0, 200)}`)
			return
		}
		if (ws.readyState !== ws.OPEN) return
		touch()
		ws.send(line, () => {
			if (paused && ws.bufferedAmount < HIGH_WATER) {
				paused = false
				resumeOut()
			}
		})
		if (!paused && ws.bufferedAmount > HIGH_WATER) {
			paused = true
			out.pause()
		}
	})
	createInterface({ input: child.stderr!, crlfDelay: Infinity }).on('line', (line) => console.log(`${tag} ${line}`))

	ws.on('close', () => harness.stop(1000, ''))
	ws.on('error', (e) => console.warn(`${tag} socket: ${e.message}`))

	child.on('error', (e: NodeJS.ErrnoException) => {
		spawnError = e.code === 'ENOENT' ? 'harness not found: set HARNESS_CMD' : 'harness failed to start'
		console.error(`${tag} ${spawnError}; the command was: ${config.cmd.join(' ')}`, ...(e.code === 'ENOENT' ? [] : [e]))
	})
	// 'close' comes once stdout has been read to the end, and also after a failed spawn
	child.on('close', (code, sig) => {
		exited = true
		killTimers.forEach(clearTimeout)
		clearTimeout(idleTimer)
		live.delete(harness)
		const left = (perBoard.get(board) ?? 1) - 1
		if (left > 0) perBoard.set(board, left)
		else if (perBoard.delete(board)) presence(board, false)
		console.log(`${tag} exited (${sig ?? `code ${code}`})`)
		const ok = code === 0 && !spawnError
		const reason = spawnError || (ok ? 'harness exited' : sig ? `harness stopped by ${sig}` : `harness exited with code ${code}`)
		if (isOpen()) ws.close(ok ? 1000 : 1011, reason)
		markClosed()
	})
}

function parseJson(text: string): object | undefined {
	try {
		const value = JSON.parse(text)
		return value !== null && typeof value === 'object' ? value : undefined
	} catch {
		return undefined
	}
}

function signal(child: ChildProcess, sig: NodeJS.Signals) {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
	try {
		process.kill(-child.pid, sig)
	} catch {
		child.kill(sig)
	}
}

function reject(socket: Duplex, status: number, reason: string) {
	socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
	socket.destroy()
}

// unref'd: the kill timers keep the process alive while a harness is still going
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref())

// On SIGINT or SIGTERM, close the chats and wait for their harnesses. If the server registers its
// own handler for the signal, that handler decides when to exit (and can await shutdownAcpPipe()).
let signalsHooked = false
function hookSignals() {
	if (signalsHooked) return
	signalsHooked = true
	for (const sig of ['SIGINT', 'SIGTERM'] as const) {
		process.on(sig, () => {
			void shutdownAcpPipe().finally(() => {
				if (process.listenerCount(sig) === 1) process.exit(sig === 'SIGINT' ? 130 : 143)
			})
		})
	}
}
