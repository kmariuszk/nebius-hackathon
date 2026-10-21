import type {
	ContentBlock,
	PermissionOption,
	PlanEntry,
	SessionUpdate,
	StopReason,
	ToolCallContent,
	ToolCallStatus,
	ToolKind,
	Usage,
} from '@agentclientprotocol/sdk'
import type { ViewerAction } from './viewerBus.ts'

// The chat panel's state as a pure reducer over ACP updates (T05), so it can be tested without a DOM.
// One turn per prompt; inside it, items in the order they arrived: thoughts, message text, tool
// cards and permission prompts.

export interface TextItem {
	kind: 'message' | 'thought'
	key: string
	messageId: string | null
	text: string
	/** A thought is done (and shown collapsed) once something else starts. */
	done: boolean
}

export interface ToolItem {
	kind: 'tool'
	key: string
	toolCallId: string
	title: string
	status: ToolCallStatus
	toolKind: ToolKind | null
	rawInput: unknown
	rawOutput: unknown
	/** The tool's text content: a one-line summary, or the error when it failed. */
	summary: string
	/** `_meta` from the call and its updates, merged: agent, model, runId, seconds, tokens, costUsd. */
	meta: Record<string, unknown>
}

export interface PermissionItem {
	kind: 'permission'
	key: string
	/** Our own ID for the pending request, to route the answer back. */
	requestId: string
	title: string
	options: PermissionOption[]
	/** The chosen option's name, or "cancelled"; null while waiting. */
	answer: string | null
}

/**
 * A button the viewer offers when the agent wanted a camera move but Follow the agent is off
 * (T06): "Show the paper", "Open <title>", "Start the tour (N papers)". Clicking runs `action`
 * as a local action. The item is plain data so turns can hold it.
 */
export interface ShowItem {
	kind: 'show'
	key: string
	label: string
	action: ViewerAction
}

export type TurnItem = TextItem | ToolItem | PermissionItem | ShowItem

export interface Turn {
	key: string
	/** Bumped by Reconnect: a new session that doesn't remember earlier turns. */
	epoch: number
	/** What the researcher typed; null for updates that arrived outside a prompt. */
	prompt: string | null
	items: TurnItem[]
	/** The agent's plan, replaced on every update. */
	plan: PlanEntry[] | null
	running: boolean
	stopReason: StopReason | null
	error: string | null
	usage: Usage | null
}

export interface ChatState {
	turns: Turn[]
	epoch: number
	/** From the latest usage_update: tokens in context, window size and the session's running cost. */
	usage: { used: number; size: number; cost: { amount: number; currency: string } | null } | null
	nextKey: number
}

export type ChatAction =
	| { type: 'send'; text: string }
	| { type: 'update'; update: SessionUpdate }
	| { type: 'stop'; stopReason: StopReason; usage?: Usage | null }
	| { type: 'error'; message: string }
	| { type: 'permission'; requestId: string; title: string; options: PermissionOption[] }
	| { type: 'permission_answered'; requestId: string; answer: string }
	| { type: 'show'; label: string; action: ViewerAction }
	| { type: 'disconnected' }
	| { type: 'reset' }

export const initialChatState: ChatState = { turns: [], epoch: 0, usage: null, nextKey: 1 }

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
	switch (action.type) {
		case 'send': {
			const s = finishRunning(state, null)
			const turn: Turn = {
				key: `t${s.nextKey}`,
				epoch: s.epoch,
				prompt: action.text,
				items: [],
				plan: null,
				running: true,
				stopReason: null,
				error: null,
				usage: null,
			}
			return { ...s, turns: [...s.turns, turn], nextKey: s.nextKey + 1 }
		}
		case 'update':
			return applyUpdate(state, action.update)
		case 'stop':
			return editLastTurn(state, (t) => ({
				...t,
				items: settleItems(t.items),
				running: false,
				stopReason: action.stopReason,
				usage: action.usage ?? null,
			}))
		case 'error':
			return editLastTurn(state, (t) => ({ ...t, items: settleItems(t.items), running: false, error: action.message }))
		case 'permission':
			return pushItem(state, (key) => ({
				kind: 'permission',
				key,
				requestId: action.requestId,
				title: action.title,
				options: action.options,
				answer: null,
			}))
		case 'permission_answered':
			return mapTurns(state, (t) =>
				t.items.some((i) => i.kind === 'permission' && i.requestId === action.requestId)
					? {
							...t,
							items: t.items.map((i) =>
								i.kind === 'permission' && i.requestId === action.requestId ? { ...i, answer: action.answer } : i
							),
						}
					: t
			)
		case 'show': {
			// a chip lands in the turn that's running; with none running it gets its own prompt-less turn
			const last = state.turns[state.turns.length - 1]
			if (last?.epoch === state.epoch && last.running)
				return pushItem(state, (key) => ({ kind: 'show', key, label: action.label, action: action.action }))
			const turn: Turn = {
				key: `t${state.nextKey}`,
				epoch: state.epoch,
				prompt: null,
				items: [{ kind: 'show', key: `i${state.nextKey + 1}`, label: action.label, action: action.action }],
				plan: null,
				running: false,
				stopReason: null,
				error: null,
				usage: null,
			}
			return { ...state, turns: [...state.turns, turn], nextKey: state.nextKey + 2 }
		}
		case 'disconnected':
			return finishRunning(state, 'The connection closed before the agent finished.')
		case 'reset':
			return { ...finishRunning(state, null), epoch: state.epoch + 1, usage: null }
	}
}

function applyUpdate(state: ChatState, update: SessionUpdate): ChatState {
	switch (update.sessionUpdate) {
		case 'agent_message_chunk':
		case 'agent_thought_chunk': {
			const kind = update.sessionUpdate === 'agent_message_chunk' ? 'message' : 'thought'
			const text = blockText(update.content)
			if (!text) return state
			const messageId = update.messageId ?? null
			const turn = state.turns[state.turns.length - 1]
			const last = turn?.epoch === state.epoch ? turn.items[turn.items.length - 1] : undefined
			const current = last?.kind === kind && !(kind === 'thought' && last.done) && last.messageId === messageId ? last : null
			// whitespace (the "\n\n" between tool cards) joins the text before it, never starts a bubble
			if (!text.trim() && !current) return state
			return editTurnOrStart(state, (t, nextKey) => {
				const items = kind === 'message' ? settleItems(t.items) : t.items
				if (current) return { ...t, items: [...items.slice(0, -1), { ...current, text: current.text + text }] }
				const item: TextItem = { kind, key: `i${nextKey()}`, messageId, text, done: false }
				return { ...t, items: [...settleItems(items), item] }
			})
		}
		case 'plan':
			return editTurnOrStart(state, (t) => ({ ...t, plan: update.entries }))
		case 'tool_call':
		case 'tool_call_update': {
			if (findTool(state, update.toolCallId)) {
				return mapTurns(state, (t) => ({
					...t,
					items: t.items.map((i) => (i.kind === 'tool' && i.toolCallId === update.toolCallId ? mergeTool(i, update) : i)),
				}))
			}
			return editTurnOrStart(state, (t, nextKey) => {
				const card: ToolItem = {
					kind: 'tool',
					key: `i${nextKey()}`,
					toolCallId: update.toolCallId,
					title: 'Tool call',
					status: 'pending',
					toolKind: null,
					rawInput: undefined,
					rawOutput: undefined,
					summary: '',
					meta: {},
				}
				return { ...t, items: [...settleItems(t.items), mergeTool(card, update)] }
			})
		}
		case 'usage_update':
			return { ...state, usage: { used: update.used, size: update.size, cost: update.cost ?? null } }
		default:
			return state
	}
}

type ToolUpdate = Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>

function mergeTool(card: ToolItem, u: ToolUpdate): ToolItem {
	return {
		...card,
		title: u.title || card.title,
		status: u.status ?? card.status,
		toolKind: u.kind ?? card.toolKind,
		rawInput: u.rawInput !== undefined ? u.rawInput : card.rawInput,
		rawOutput: u.rawOutput !== undefined ? u.rawOutput : card.rawOutput,
		summary: u.content ? contentText(u.content) || card.summary : card.summary,
		meta: { ...card.meta, ...u._meta },
	}
}

function blockText(block: ContentBlock): string {
	if (block.type === 'text') return block.text
	if (block.type === 'resource_link') return `[${block.title ?? block.name}](${block.uri})`
	return ''
}

function contentText(content: ToolCallContent[]): string {
	return content
		.map((c) => (c.type === 'content' ? blockText(c.content) : ''))
		.filter(Boolean)
		.join('\n')
}

/** Thoughts collapse once anything else starts. */
function settleItems(items: TurnItem[]): TurnItem[] {
	return items.some((i) => i.kind === 'thought' && !i.done)
		? items.map((i) => (i.kind === 'thought' && !i.done ? { ...i, done: true } : i))
		: items
}

function findTool(state: ChatState, toolCallId: string) {
	return state.turns.some((t) => t.items.some((i) => i.kind === 'tool' && i.toolCallId === toolCallId))
}

function mapTurns(state: ChatState, fn: (t: Turn) => Turn): ChatState {
	return { ...state, turns: state.turns.map(fn) }
}

function editLastTurn(state: ChatState, fn: (t: Turn) => Turn): ChatState {
	const last = state.turns[state.turns.length - 1]
	return last ? { ...state, turns: [...state.turns.slice(0, -1), fn(last)] } : state
}

/** Edits the latest turn, or starts one for updates that arrive before any prompt. */
function editTurnOrStart(state: ChatState, fn: (t: Turn, nextKey: () => number) => Turn): ChatState {
	let key = state.nextKey
	const nextKey = () => key++
	let turns = state.turns
	const last = turns[turns.length - 1]
	if (!last || last.epoch !== state.epoch) {
		const turn: Turn = {
			key: `t${nextKey()}`,
			epoch: state.epoch,
			prompt: null,
			items: [],
			plan: null,
			running: false,
			stopReason: null,
			error: null,
			usage: null,
		}
		turns = [...turns, turn]
	}
	const edited = fn(turns[turns.length - 1], nextKey)
	return { ...state, turns: [...turns.slice(0, -1), edited], nextKey: key }
}

function pushItem(state: ChatState, make: (key: string) => TurnItem): ChatState {
	return editTurnOrStart(state, (t, nextKey) => ({ ...t, items: [...t.items, make(`i${nextKey()}`)] }))
}

/** Ends a turn that is still running (with an error, if given) and cancels its open permission prompts. */
function finishRunning(state: ChatState, error: string | null): ChatState {
	return mapTurns(state, (t) =>
		t.running || t.items.some((i) => i.kind === 'permission' && i.answer === null)
			? {
					...t,
					running: false,
					error: t.running ? error : t.error,
					items: settleItems(t.items).map((i) => (i.kind === 'permission' && i.answer === null ? { ...i, answer: 'cancelled' } : i)),
				}
			: t
	)
}
