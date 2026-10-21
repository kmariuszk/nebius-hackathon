import { useEffect, useRef, useState } from 'react'
import { loopPath } from '../shapes/card'

// The ? at the bottom right (T13): the v6 key, "How to read the board", then how to edit it. The
// wording is the v6 demo board's, for what this board draws.

const string = (color: string, width: number, dotted = false) => (
	<svg width="28" height="10" aria-hidden="true">
		<path
			d="M2 2 Q14 10 26 2"
			fill="none"
			stroke={color}
			strokeWidth={width}
			strokeDasharray={dotted ? '.5 4' : undefined}
			strokeLinecap="round"
		/>
	</svg>
)

export function Help() {
	const [open, setOpen] = useState(false)
	const ref = useRef<HTMLDivElement>(null)
	useEffect(() => {
		if (!open) return
		const outside = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) setOpen(false)
		}
		const escape = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
		document.addEventListener('pointerdown', outside)
		document.addEventListener('keydown', escape)
		return () => {
			document.removeEventListener('pointerdown', outside)
			document.removeEventListener('keydown', escape)
		}
	}, [open])
	return (
		<div className="pb-controls" ref={ref}>
			<button type="button" className="pb-ctl" aria-expanded={open} onClick={() => setOpen(!open)} title="How to read the board">
				?
			</button>
			{open && (
				<div className="pb-pop pb-legend" role="dialog" aria-label="How to read the board">
					<h6>How to read the board</h6>
					<div className="row">
						<i className="ic">
							<i className="kc saved" />
						</i>
						<span>
							<b>In your collection</b> · pinned: a seed, or a paper someone kept
						</span>
					</div>
					<div className="row">
						<i className="ic">
							<i className="kc sugg" />
						</i>
						<span>
							<b>Suggested</b> · taped up, not saved yet, with its fit for what you’re <b>Looking for</b>. Keep pins it.
						</span>
					</div>
					<div className="row">
						<i className="ic">
							<svg width="28" height="28" viewBox="-14 -14 28 28" aria-hidden="true">
								<path d={loopPath(0, 0, 11, 10, 7)} fill="var(--pb-paperw)" stroke="var(--pb-marker)" strokeWidth="2" />
								<text y="5" textAnchor="middle" style={{ font: '600 14px var(--pb-hand)', fill: 'var(--pb-marker)' }}>
									1
								</text>
							</svg>
						</i>
						<span>
							The agent’s reading order for what you’re <b>Looking for</b>. 1 = read first.
						</span>
					</div>
					<div className="row">
						<i className="ic">
							<span className="kb">New</span>
						</i>
						<span>Status on the corner: New, Split vote, Reading…, ✓ Kept, Discarded</span>
					</div>
					<div className="row">
						<i className="ic">{string('var(--pb-string)', 2)}</i>
						<span>cites</span>
					</div>
					<div className="row">
						<i className="ic">{string('#2e2a25', 1.6, true)}</i>
						<span>similar (the agent’s guess)</span>
					</div>
					<div className="row">
						<i className="ic">{string('var(--pb-yarn)', 2.2)}</i>
						<span>a link you drew</span>
					</div>
					<div className="row">
						<i className="ic">
							<i className="kcl" />
						</i>
						<span>
							<b>Cluster</b> · papers with similar abstracts, grouped by the agent
						</span>
					</div>
					<div className="row">
						<i className="ic">
							<i className="kn" />
						</i>
						<span>Team note</span>
					</div>
					<div className="row">
						<i className="ic">
							<span className="ka">abc</span>
						</i>
						<span>The agent’s note</span>
					</div>
					<div className="row">
						<i className="ic">
							<svg width="28" height="16" aria-hidden="true">
								<ellipse cx="14" cy="8" rx="12" ry="6" fill="none" stroke="var(--pb-marker)" strokeWidth="2" />
							</svg>
						</i>
						<span>The paper you’ve opened</span>
					</div>
					<h6>Editing</h6>
					<div className="row">Drag papers and notes to move them.</div>
					<div className="row">
						<span>
							Hover a paper and drag its <span className="plus">+</span> onto another paper to link them.
						</span>
					</div>
					<div className="row">Click a link to name it, hide it or delete it.</div>
					<div className="row">Drop a note on a paper to pin it there. Double-click a note to edit it.</div>
					<div className="row">Double-click a cluster’s name to rename it.</div>
					<div className="row">The agent waits until you press Update suggestions.</div>
					<div className="row">Click an open paper again for more.</div>
					<div className="row">Scroll to move around; pinch or ⌘-scroll to zoom. ⌘Z undoes, ⇧⌘Z redoes.</div>
				</div>
			)}
		</div>
	)
}
