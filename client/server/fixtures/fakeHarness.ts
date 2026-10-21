import { createInterface } from 'node:readline'

// A stand-in for `python -m harness` in the pipe and chat connection tests: a tiny stdio ACP agent
// that echoes, misbehaves on purpose and reports its environment. FAKE_HARNESS picks extra
// behaviour: `ignore-eof` keeps running after stdin ends, `ignore-term` also survives SIGTERM.

const mode = process.env.FAKE_HARNESS ?? ''
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n')
const reply = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result })
const update = (sessionId: string, update: object) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })

// stray output a real harness must never print; the pipe has to drop it
process.stdout.write('banner: this line is not JSON\n')
process.stdout.write('42\n')
process.stderr.write('fake harness ready\n')

if (mode.includes('ignore-eof')) setInterval(() => {}, 60_000)
if (mode.includes('ignore-term')) process.on('SIGTERM', () => {})

let prompt: { id: unknown; sessionId: string } | null = null
let mcpServers: unknown = null
const pending = new Map<unknown, (message: any) => void>()

createInterface({ input: process.stdin }).on('line', (line) => {
	const message = JSON.parse(line)
	if (message.id !== undefined && !message.method) return pending.get(message.id)?.(message)
	const { id, method, params } = message
	switch (method) {
		case 'env':
			return reply(id, { pid: process.pid, line, env: pick(process.env, 'BOARD_ID', 'MEMBER_ID', 'BOARD_INTERNAL_URL', 'PYTHONUNBUFFERED') })
		case 'exit':
			return process.exit(params?.code ?? 0)
		case 'flood':
			for (let i = 0; i < params.count; i++) send({ jsonrpc: '2.0', method: 'flood', params: { i, pad: 'x'.repeat(params.size) } })
			return
		case 'initialize':
			return reply(id, {
				protocolVersion: 1,
				agentCapabilities: { loadSession: false },
				agentInfo: { name: 'fake-harness', version: '0.0.0' },
				authMethods: [],
			})
		case 'session/new':
			mcpServers = params.mcpServers
			return reply(id, { sessionId: 's_fake00000000' })
		case 'session/prompt':
			return void runPrompt(id, params)
		case 'session/cancel':
			if (prompt) reply(prompt.id, { stopReason: 'cancelled' })
			prompt = null
			return
		default:
			return send({ jsonrpc: '2.0', method: 'echo', params: { message, line } })
	}
})
process.stdin.on('end', () => {
	if (!mode.includes('ignore-eof')) process.exit(0)
})

// Echo-mode-like turn: a plan, a tool card, a focus for the viewer, the text back, then end_turn.
// "wait" leaves the turn open until session/cancel, "snapshot" asks the browser for a picture
// first, "crash" exits with code 3.
async function runPrompt(id: unknown, params: { sessionId: string; prompt: { type: string; text?: string }[] }) {
	const { sessionId } = params
	const text = params.prompt.map((b) => b.text ?? '').join('')
	if (text.includes('crash')) process.exit(3)
	prompt = { id, sessionId }
	update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking about it.' } })
	update(sessionId, {
		sessionUpdate: 'plan',
		entries: [
			{ content: 'Read the prompt', priority: 'high', status: 'completed' },
			{ content: 'Echo it back', priority: 'medium', status: 'in_progress' },
		],
	})
	update(sessionId, {
		sessionUpdate: 'tool_call',
		toolCallId: 'call_1',
		title: 'echo: repeat',
		kind: 'other',
		status: 'in_progress',
		rawInput: { text },
		_meta: { agent: 'echo', model: 'nvidia/Nemotron-3.5-Super-VL' },
	})
	if (text.includes('snapshot')) {
		const { error, result } = await request('_canvas/snapshot', { sessionId, target: 'viewport' })
		const seen = error ? error.message : `${result.width}×${result.height}, ${result.caption}`
		update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `snapshot: ${seen}. ` } })
	}
	update(sessionId, {
		sessionUpdate: 'tool_call_update',
		toolCallId: 'call_1',
		status: 'completed',
		rawOutput: { added: ['pmid:1'] },
		_meta: { seconds: 0.4, costUsd: 0.001 },
	})
	send({ jsonrpc: '2.0', method: '_canvas/focus', params: { sessionId, paperIds: ['pmid:1'] } })
	if (text.includes('wait')) return
	for (const word of text.split(/(?<= )/)) update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: word } })
	update(sessionId, { sessionUpdate: 'usage_update', used: 1200, size: 128000, cost: { amount: 0.002, currency: 'USD' } })
	prompt = null
	reply(id, { stopReason: 'end_turn', _meta: { mcpServers } })
}

let nextId = 0
function request(method: string, params: unknown): Promise<any> {
	const id = `fake-${nextId++}`
	send({ jsonrpc: '2.0', id, method, params })
	return new Promise((resolve) => pending.set(id, resolve))
}

function pick(env: NodeJS.ProcessEnv, ...keys: string[]) {
	return Object.fromEntries(keys.map((k) => [k, env[k]]))
}
