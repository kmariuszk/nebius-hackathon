import { useEffect, useRef, useState } from 'react'
import { useValue, type Editor } from 'tldraw'
import { boardApi, type Board } from '../api'
import { GOALS } from '../shapes/card'
import { currentGoal } from '../viewerState'
import { boardSteps, startCatchUp } from '../widgets/tour'
import { BotIcon } from './BotIcon'

// The v6 top bar (docs/mockups/flashcard-v6.html): back to your boards, the board's title (its
// question on hover), what you're looking for, the Pinboard switch, who's here (the agent too,
// while it works on the board), Catch me up and Chat.

export type Wall = 'paper' | 'cork'

interface TopBarProps {
	roomId: string
	memberId: string
	editor: Editor | null
	wall: Wall
	onWall: (wall: Wall) => void
	chatOpen: boolean
	onChat: () => void
}

export function TopBar({ roomId, memberId, editor, wall, onWall, chatOpen, onChat }: TopBarProps) {
	const { board, agentActive } = useBoardInfo(roomId, memberId)
	return (
		<header className="pb-topbar">
			<a className="pb-back" href="/landing/home.html" title="Back to your boards">
				<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
					<path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
				Boards
			</a>
			<div className="pb-logo" aria-hidden="true">
				<svg width="14" height="14" viewBox="0 0 16 16">
					<circle cx="5" cy="5" r="3" fill="#fff" />
					<circle cx="11.5" cy="11" r="2.5" fill="#86b6ef" />
					<path d="M7 7 L10 9.5" stroke="#fff" strokeWidth="1.5" />
				</svg>
			</div>
			{/* the room ID only until the board service answers */}
			<div className="pb-board" title={board?.question || undefined}>
				{board ? board.title || board.question || roomId : roomId}
			</div>
			<LookingFor />
			<div className="pb-grow" />
			<label className="pb-toggle" title="Switch the background between paper and a cork pinboard">
				<span>Pinboard</span>
				<input type="checkbox" checked={wall === 'cork'} onChange={(e) => onWall(e.target.checked ? 'cork' : 'paper')} />
				<i />
			</label>
			{editor && <Avatars editor={editor} agent={agentActive} />}
			{editor && <CatchMeUp editor={editor} />}
			<button type="button" className="pb-btn" aria-pressed={chatOpen} onClick={onChat} title="Chat with the agent">
				<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
					<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" strokeLinejoin="round" />
				</svg>
				Chat
			</button>
		</header>
	)
}

function LookingFor() {
	const goal = useValue(currentGoal)
	const [open, setOpen] = useState(false)
	const ref = useRef<HTMLDivElement>(null)
	useEffect(() => {
		if (!open) return
		const close = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) setOpen(false)
		}
		document.addEventListener('pointerdown', close)
		return () => document.removeEventListener('pointerdown', close)
	}, [open])
	return (
		<div className="pb-lookfor" ref={ref}>
			<button type="button" className="pb-lf" aria-expanded={open} onClick={() => setOpen(!open)}>
				Looking for <b>{GOALS[goal]?.label ?? goal}</b> ▾
			</button>
			{open && (
				<div className="pb-pop" role="menu">
					<h6>Looking for</h6>
					{Object.entries(GOALS).map(([id, g]) => (
						<button
							type="button"
							role="menuitemradio"
							aria-checked={id === goal}
							key={id}
							className="pb-opt"
							onClick={() => {
								currentGoal.set(id)
								setOpen(false)
							}}
						>
							<b>{g.label}</b>
							<span>{g.desc}</span>
						</button>
					))}
				</div>
			)}
		</div>
	)
}

/**
 * The board's title and question (GET /boards/:id) and whether an agent is working on it: read on
 * load and when the window comes back into focus, and kept current from the board's event stream
 * (T08's agent.active and agent.idle).
 */
function useBoardInfo(roomId: string, memberId: string) {
	const [board, setBoard] = useState<Board | null>(null)
	const [agentActive, setAgentActive] = useState(false)
	useEffect(() => {
		let live = true
		const api = boardApi(roomId, memberId)
		const load = () =>
			api.get().then(
				(b) => {
					if (!live) return
					setBoard(b)
					setAgentActive(b.agentActive)
				},
				(e) => console.warn(`Couldn't read board ${roomId}:`, e)
			)
		void load()
		window.addEventListener('focus', load)
		const events = new EventSource(`/api/v1/boards/${encodeURIComponent(roomId)}/events`)
		const active = () => setAgentActive(true)
		const idle = () => setAgentActive(false)
		events.addEventListener('agent.active', active)
		events.addEventListener('agent.idle', idle)
		return () => {
			live = false
			window.removeEventListener('focus', load)
			events.close()
		}
	}, [roomId, memberId])
	return { board, agentActive }
}

function Avatars({ editor, agent }: { editor: Editor; agent: boolean }) {
	const people = useValue(
		'people',
		() => [
			{ id: 'me', name: editor.user.getName(), color: editor.user.getColor() },
			...editor.getCollaborators().map((c) => ({ id: c.userId, name: c.userName, color: c.color })),
		],
		[editor]
	)
	const seen = new Set<string>()
	const unique = people.filter((p) => !seen.has(p.id) && seen.add(p.id))
	return (
		<div className="pb-avs">
			{unique.slice(0, 5).map((p) => (
				<div key={p.id} className="pb-av" style={{ background: p.color }} title={p.id === 'me' ? `${p.name || 'You'} (you)` : p.name}>
					{(p.name || (p.id === 'me' ? 'You' : '?')).trim().charAt(0).toUpperCase()}
				</div>
			))}
			{/* only while an agent's harness is connected to this board */}
			{agent && (
				<div className="pb-av bot" title="The agent is working on this board">
					<BotIcon />
				</div>
			)}
		</div>
	)
}

// a tour of the new papers in this viewer's ranking order, run in this browser from the board's
// own data, with no prompt to the agent (T06, decision D24)
function CatchMeUp({ editor }: { editor: Editor }) {
	const count = useValue('catch-up papers', () => boardSteps(editor).length, [editor])
	return (
		<button type="button" className="pb-btn primary" onClick={() => startCatchUp(editor)} disabled={!count} title="Open the new papers one by one">
			Catch me up <span className="pb-count">{count}</span>
		</button>
	)
}
