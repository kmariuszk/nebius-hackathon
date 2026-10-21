import type { PermissionOption, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { Fragment, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type SyntheticEvent } from 'react'
import type { Editor } from 'tldraw'
import { AgentMessage } from './AgentMessage'
import './chat.css'
import { chatBus, chatTurns, endedTurns, promptBlocks, type AskRequest } from './chatBus'
import { chatReducer, initialChatState, type Turn } from './chatState'
import { openAgentConnection, type AgentConnection } from './connection'
import { formatCost, formatTokens, stopReasonText } from './format'
import { PermissionPrompt } from './PermissionPrompt'
import { PlanList } from './PlanList'
import { ThoughtBlock } from './ThoughtBlock'
import { ToolCard } from './ToolCard'
import { registerViewerActions } from './viewerActions'
import { viewerBus } from './viewerBus'

export interface ChatPanelProps {
	boardId: string
	memberId: string
	/** Null until the canvas has mounted. */
	editor: Editor | null
	/** Opened and closed from the top bar's Chat button. */
	open: boolean
	onOpenChange: (open: boolean) => void
}

type Status = 'idle' | 'connecting' | 'ready' | 'closed'

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }

// The chat panel (T05): a column beside the canvas, a narrow rail when closed. The ACP connection
// (and with it the harness process) starts the first time the panel opens, not on page load.
export function ChatPanel({ boardId, memberId, editor, open, onOpenChange: setOpen }: ChatPanelProps) {
	const [status, setStatus] = useState<Status>('idle')
	const [closeReason, setCloseReason] = useState('')
	const [state, dispatch] = useReducer(chatReducer, initialChatState)
	const [draft, setDraft] = useState('')
	const [notice, setNotice] = useState<string | null>(null)
	const conn = useRef<AgentConnection | null>(null)
	const permissions = useRef(new Map<string, (r: RequestPermissionResponse) => void>())
	const attempt = useRef(0)
	const lastTurn = state.turns[state.turns.length - 1]
	const running = !!lastTurn?.running

	useEffect(() => (editor ? registerViewerActions(editor) : undefined), [editor])

	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined
		const off = viewerBus.on('notice', ({ text }) => {
			setNotice(text)
			clearTimeout(timer)
			timer = setTimeout(() => setNotice(null), 4000)
		})
		return () => {
			off()
			clearTimeout(timer)
		}
	}, [])

	const cancelPermissions = useCallback(() => {
		for (const [requestId, settle] of permissions.current) {
			settle(CANCELLED)
			dispatch({ type: 'permission_answered', requestId, answer: 'cancelled' })
		}
	}, [])

	const disconnect = useCallback(() => {
		attempt.current++
		cancelPermissions()
		conn.current?.close()
		conn.current = null
	}, [cancelPermissions])

	const connect = useCallback(async () => {
		const mine = ++attempt.current
		setStatus('connecting')
		try {
			const c = await openAgentConnection({
				boardId,
				memberId,
				handlers: {
					onUpdate: (n) => attempt.current === mine && dispatch({ type: 'update', update: n.update }),
					onPermission: (params, signal) =>
						new Promise((resolve) => {
							const requestId = `p${Math.random().toString(36).slice(2)}`
							const settle = (r: RequestPermissionResponse) => {
								permissions.current.delete(requestId)
								resolve(r)
							}
							permissions.current.set(requestId, settle)
							signal.addEventListener('abort', () => {
								if (!permissions.current.has(requestId)) return
								settle(CANCELLED)
								dispatch({ type: 'permission_answered', requestId, answer: 'cancelled' })
							})
							dispatch({ type: 'permission', requestId, title: params.toolCall.title ?? 'use a tool', options: params.options })
						}),
					onClose: (reason) => {
						if (attempt.current !== mine) return // we closed it ourselves
						conn.current = null
						cancelPermissions()
						dispatch({ type: 'disconnected' })
						setCloseReason(reason)
						setStatus('closed')
					},
				},
			})
			if (attempt.current !== mine) return c.close()
			conn.current = c
			setStatus('ready')
		} catch (e) {
			if (attempt.current !== mine) return
			setCloseReason(e instanceof Error ? e.message : String(e))
			setStatus('closed')
		}
	}, [boardId, memberId, cancelPermissions])

	useEffect(() => {
		if (open && status === 'idle') void connect()
	}, [open, status, connect])

	// a different board or member is a different chat
	useEffect(
		() => () => {
			disconnect()
			dispatch({ type: 'reset' })
			setStatus('idle')
		},
		[boardId, memberId, disconnect]
	)

	const sendPrompt = (c: AgentConnection, request: AskRequest) => {
		dispatch({ type: 'send', text: request.text })
		c.prompt(promptBlocks(request)).then(
			(res) => dispatch({ type: 'stop', stopReason: res.stopReason, usage: res.usage }),
			(e) => {
				// a dropped connection is reported by onClose
				if (conn.current === c) dispatch({ type: 'error', message: `Something went wrong: ${e instanceof Error ? e.message : e}` })
			}
		)
	}

	const send = () => {
		const text = draft.trim()
		const c = conn.current
		if (!text || !c || running) return
		setDraft('')
		sendPrompt(c, { text })
	}

	// requests from elsewhere in the app (chatBus): open the panel, which connects, then send each
	// one once the chat is ready and no turn is running
	const asks = useRef<AskRequest[]>([])
	const [asked, setAsked] = useState(0)
	useEffect(
		() =>
			chatBus.onAsk((request) => {
				asks.current.push(request)
				setAsked((n) => n + 1)
				setOpen(true)
			}),
		[setOpen]
	)
	useEffect(() => {
		const c = conn.current
		if (status !== 'ready' || !c || running || !asks.current.length) return
		sendPrompt(c, asks.current.shift()!)
	}, [status, running, asked])

	const stop = () => {
		cancelPermissions()
		void conn.current?.cancel()
	}

	const answer = (requestId: string, option: PermissionOption) => {
		permissions.current.get(requestId)?.({ outcome: { outcome: 'selected', optionId: option.optionId } })
		dispatch({ type: 'permission_answered', requestId, answer: option.name })
	}

	const reconnect = () => {
		disconnect()
		dispatch({ type: 'reset' })
		void connect()
	}

	// follow the stream while the researcher is at the bottom; leave them be if they scrolled up
	const body = useRef<HTMLDivElement>(null)
	const atBottom = useRef(true)
	useLayoutEffect(() => {
		if (atBottom.current && body.current) body.current.scrollTop = body.current.scrollHeight
	}, [state, status, open])
	useTurnEvents(state.turns, body, setOpen)

	const usage = state.usage
	const tokens = usage?.used ?? lastTurn?.usage?.totalTokens
	const usageLine = [
		tokens !== undefined && `${formatTokens(tokens)} tokens`,
		usage?.cost && `${formatCost(usage.cost.amount, usage.cost.currency)} this chat`,
	]
		.filter(Boolean)
		.join(' · ')

	return (
		// The panel sits outside <Tldraw>, but tldraw listens for shortcuts and clipboard events on
		// the whole document while the canvas is focused: a Delete or a letter pressed on one of our
		// buttons, or Cmd+C on selected chat text, would reach the canvas. Stop them here.
		<aside
			className="ChatPanel"
			data-open={open}
			aria-label="Chat with the agent"
			onKeyDown={stopPropagation}
			onKeyUp={stopPropagation}
			onCopy={stopPropagation}
			onCut={stopPropagation}
			onPaste={stopPropagation}
		>
			{!open ? (
				<button type="button" className="ChatPanel-rail" aria-expanded={false} onClick={() => setOpen(true)} title="Chat with the agent">
					<ChatIcon />
					<span>Chat</span>
				</button>
			) : (
				<>
					<header className="ChatPanel-header">
						<div>
							<div className="ChatPanel-title">Agent</div>
							<small>Only you see this chat. What the agent adds to the board, everyone sees.</small>
						</div>
						<button type="button" className="ChatPanel-x" aria-expanded={true} onClick={() => setOpen(false)} title="Hide the chat">
							×
						</button>
					</header>
					{status === 'closed' && (
						<div className="ChatPanel-banner" role="alert">
							<div>
								The chat closed ({closeReason}). Reconnect starts a fresh conversation: the agent won’t remember the
								messages above.
							</div>
							<button type="button" className="ChatBtn" onClick={reconnect}>
								Reconnect
							</button>
						</div>
					)}
					<div
						ref={body}
						className="ChatPanel-body"
						role="log"
						aria-live="polite"
						aria-busy={running}
						onScroll={(e) => {
							const el = e.currentTarget
							atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
						}}
					>
						{state.turns.length === 0 && (
							<div className="ChatPanel-empty">
								{status === 'connecting'
									? 'Starting the agent…'
									: 'Ask the agent to find papers, explain what’s on the board or add a note. Papers it mentions are clickable.'}
							</div>
						)}
						{state.turns.map((turn, i) => (
							<Fragment key={turn.key}>
								{i > 0 && turn.epoch !== state.turns[i - 1].epoch && <div className="ChatPanel-divider">New conversation</div>}
								<TurnView turn={turn} onAnswer={answer} />
							</Fragment>
						))}
					</div>
					<footer className="ChatPanel-foot">
						<div className="ChatPanel-ctx">{notice ?? usageLine}</div>
						<div className="ChatPanel-input">
							<textarea
								autoFocus
								value={draft}
								aria-label="Message to the agent"
								placeholder={status === 'connecting' ? 'Starting the agent…' : 'Ask about the board…'}
								onChange={(e) => setDraft(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
										e.preventDefault()
										send()
									}
								}}
							/>
							{running ? (
								<button type="button" className="ChatBtn ChatBtn--primary ChatPanel-send" onClick={stop}>
									Stop
								</button>
							) : (
								<button
									type="button"
									className="ChatBtn ChatBtn--primary ChatPanel-send"
									disabled={status !== 'ready' || !draft.trim()}
									onClick={send}
								>
									Send
								</button>
							)}
						</div>
					</footer>
				</>
			)}
		</aside>
	)
}

function TurnView({ turn, onAnswer }: { turn: Turn; onAnswer: (requestId: string, option: PermissionOption) => void }) {
	const last = turn.items[turn.items.length - 1]
	const streaming = turn.running && last?.kind === 'message'
	const stopText = stopReasonText(turn.stopReason)
	return (
		<div className="ChatTurn" data-turn={turn.key}>
			{turn.prompt !== null && <div className="ChatMsg-user">{turn.prompt}</div>}
			{turn.plan && <PlanList entries={turn.plan} />}
			{turn.items.map((item) => {
				switch (item.kind) {
					case 'thought':
						return <ThoughtBlock key={item.key} text={item.text} done={item.done} />
					case 'message':
						return <AgentMessage key={item.key} text={item.text} />
					case 'tool':
						return <ToolCard key={item.key} card={item} />
					case 'permission':
						return <PermissionPrompt key={item.key} item={item} onAnswer={onAnswer} />
				}
			})}
			{turn.running && !streaming && (
				<div className="ChatMsg-agent" aria-label="The agent is working">
					<span className="spin" />
				</div>
			)}
			{stopText && <div className={turn.stopReason === 'cancelled' ? 'ChatTag' : 'ChatNote'}>{stopText}</div>}
			{turn.error && <div className="ChatNote ChatNote--error">{turn.error}</div>}
		</div>
	)
}

function stopPropagation(e: SyntheticEvent) {
	e.stopPropagation()
}

// T13's "See what it did": tells the rest of the app when a turn ends (chatTurns), and opens the
// chat scrolled to a turn when asked
function useTurnEvents(turns: Turn[], body: { current: HTMLDivElement | null }, setOpen: (open: boolean) => void) {
	const before = useRef(turns)
	useEffect(() => {
		const ended = endedTurns(before.current, turns)
		before.current = turns
		for (const end of ended) chatTurns.ended(end)
	}, [turns])
	const [target, setTarget] = useState<string | null>(null)
	useEffect(
		() =>
			chatTurns.onShow((key) => {
				setOpen(true)
				setTarget(key)
			}),
		[setOpen]
	)
	// once the panel is open and the turn is drawn
	useLayoutEffect(() => {
		const list = body.current
		const turn = target ? list?.querySelector(`[data-turn="${target}"]`) : null
		if (!list || !turn) return
		list.scrollTop += turn.getBoundingClientRect().top - list.getBoundingClientRect().top
		setTarget(null)
	})
}

function ChatIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
			<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" strokeLinejoin="round" />
		</svg>
	)
}
