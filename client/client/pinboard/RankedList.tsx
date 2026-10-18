import { useState, type ReactNode } from 'react'
import { useValue, type Editor } from 'tldraw'
import { sentenceCase, shortAuthors } from '../../shared/display'
import { boardDerived, FIT_LABEL, GOALS } from '../shapes/card'
import { currentGoal, openPaperId, paperMoreOpen } from '../viewerState'

// The v6 ranked list: the suggestions in the agent's reading order for what you're looking for.

const FIT_COLOR = { high: '#104281', medium: '#2a78d6', low: '#86b6ef' } as const

export function RankedList({ editor }: { editor: Editor }) {
	const [open, setOpen] = useState(false)
	const ranked = useValue('ranked list', () => boardDerived(editor).ranked, [editor])
	const goal = useValue(currentGoal)
	const sel = useValue(openPaperId)

	if (!open) {
		return (
			<button type="button" className="pb-listtoggle" onClick={() => setOpen(true)} title="Show the ranked list">
				<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
					<path d="M5.5 4h8M5.5 8h8M5.5 12h8" />
					<circle cx="2.5" cy="4" r=".9" fill="currentColor" />
					<circle cx="2.5" cy="8" r=".9" fill="currentColor" />
					<circle cx="2.5" cy="12" r=".9" fill="currentColor" />
				</svg>
				Ranked list <span className="pb-count">{ranked.length}</span>
			</button>
		)
	}

	return (
		<aside className="pb-list" aria-label="Ranked list" onKeyDown={(e) => e.stopPropagation()}>
			<header>
				<div>
					<div className="h">Ranked for {(GOALS[goal]?.label ?? goal).toLowerCase()}</div>
					<small>{ranked.length} suggestions</small>
				</div>
				<button type="button" className="xs" onClick={() => setOpen(false)} title="Hide the list">
					×
				</button>
			</header>
			<div className="rows">
				{ranked.map((s, i) => {
					const p = s.props
					const fit = p.scores[goal]?.fit
					const kick: ReactNode[] = []
					if (fit)
						kick.push(
							<span key="fit" className="fit">
								<span className="sw" style={{ background: FIT_COLOR[fit] }} />
								{FIT_LABEL[fit]}
							</span>
						)
					if (p.status === 'new') kick.push('New')
					if (p.status === 'contested') kick.push(<span key="split" className="flag">Split vote</span>)
					if (p.type === 'preprint') kick.push(<span key="pre" className="flag">Preprint</span>)
					if (p.type === 'review') kick.push('Review')
					return (
						<button
							type="button"
							key={s.id}
							className={`lrow${sel === p.paperId ? ' sel' : ''}`}
							onClick={() => {
								openPaperId.set(p.paperId)
								paperMoreOpen.set(false)
							}}
						>
							<div className="rk">{i + 1}</div>
							<div>
								<div className="lkick">
									{kick.map((k, j) => (
										<span key={j}>
											{j > 0 && ' · '}
											{k}
										</span>
									))}
								</div>
								<div className="lt">{sentenceCase(p.title)}</div>
								<div className="lm">{[shortAuthors(p.authors), p.venue, p.year].filter(Boolean).join(' · ')}</div>
								{p.scores[goal]?.why && <div className="lwhy">{p.scores[goal].why}</div>}
							</div>
							{p.figure ? <img className="lthumb" src={p.figure.imageUrl} alt="" /> : <div className="lthumb none">no figure</div>}
						</button>
					)
				})}
				{!ranked.length && <div className="empty">No suggestions yet. Ask the agent to find papers.</div>}
			</div>
		</aside>
	)
}
