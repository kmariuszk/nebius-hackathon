import { useEffect, useRef, useState } from 'react'
import { useValue, type Editor } from 'tldraw'
import { boardDerived, GOALS } from '../shapes/card'
import { currentGoal, openPaperId, paperMoreOpen } from '../viewerState'

// The v6 top bar (docs/mockups/flashcard-v6.html): back to your boards, the board, what you're
// looking for, the Pinboard switch, who's here, Catch me up and Chat.

export type Wall = 'paper' | 'cork'

interface TopBarProps {
	roomId: string
	editor: Editor | null
	wall: Wall
	onWall: (wall: Wall) => void
	chatOpen: boolean
	onChat: () => void
}

export function TopBar({ roomId, editor, wall, onWall, chatOpen, onChat }: TopBarProps) {
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
			<div className="pb-board">{roomId}</div>
			<LookingFor />
			<div className="pb-grow" />
			<label className="pb-toggle" title="Switch the background between paper and a cork pinboard">
				<span>Pinboard</span>
				<input type="checkbox" checked={wall === 'cork'} onChange={(e) => onWall(e.target.checked ? 'cork' : 'paper')} />
				<i />
			</label>
			{editor && <Avatars editor={editor} />}
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

function Avatars({ editor }: { editor: Editor }) {
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
			<div className="pb-av bot" title="The agent">
				<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
					<rect x="2" y="4.5" width="12" height="9" rx="3" fill="none" stroke="#fff" strokeWidth="1.5" />
					<circle cx="6" cy="9" r="1.2" fill="#fff" />
					<circle cx="10" cy="9" r="1.2" fill="#fff" />
					<path d="M8 4.5V2" stroke="#fff" strokeWidth="1.5" />
				</svg>
			</div>
		</div>
	)
}

// steps through the new papers in the agent's reading order, opening each one's widgets
function CatchMeUp({ editor }: { editor: Editor }) {
	const fresh = useValue('fresh papers', () => boardDerived(editor).fresh, [editor])
	const next = () => {
		if (!fresh.length) return
		const i = fresh.indexOf(openPaperId.get() ?? '')
		openPaperId.set(fresh[(i + 1) % fresh.length])
		paperMoreOpen.set(false)
	}
	return (
		<button type="button" className="pb-btn primary" onClick={next} disabled={!fresh.length} title="Open the new papers one by one">
			Catch me up <span className="pb-count">{fresh.length}</span>
		</button>
	)
}
