import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useValue, type Editor } from 'tldraw'
import { nodeLabel } from '../../shared/display'
import type { PaperCardShape } from '../../shared/shapes'
import { boardDerived, FIT_LABEL } from '../shapes/card'
import { currentGoal, filters, type BoardFilters } from '../viewerState'
import { activeCount, CITED_AT_LEAST, DEFAULT_FILTERS, filterOptions, toggled } from './filters'
import { FIT_COLOR } from './RankedList'

// The v6 Filter button in the toolbar and its panel (T09): fit, type, quality, year and discarded
// papers, for this viewer only. Options no paper on the board has data for are left out.

const update = (patch: Partial<BoardFilters>) => filters.set({ ...filters.get(), ...patch })

export function FilterButton({ editor }: { editor: Editor }) {
	const count = useValue('active filters', () => activeCount(filters.get()), [])
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
		<div
			className="pb-filter"
			ref={ref}
			onKeyDown={(e) => {
				if (e.key !== 'Escape' || !open) return
				e.stopPropagation()
				setOpen(false)
			}}
		>
			<button type="button" className="pb-filterbtn" aria-expanded={open} onClick={() => setOpen(!open)} title="Filter the suggestions">
				<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
					<path d="M2 3.5h12M4.5 8h7M7 12.5h2" />
				</svg>
				Filter
				{count > 0 && <span className="badge">{count}</span>}
			</button>
			{open && <FilterPanel editor={editor} onClose={() => setOpen(false)} />}
		</div>
	)
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
	return (
		<button type="button" className="pb-fchip" aria-pressed={on} onClick={onClick}>
			{children}
		</button>
	)
}

function FilterPanel({ editor, onClose }: { editor: Editor; onClose: () => void }) {
	const f = useValue(filters)
	const goal = useValue(currentGoal)
	const cards = useValue(
		'filter cards',
		() =>
			editor
				.getCurrentPageShapes()
				.filter((s): s is PaperCardShape => s.type === 'paper-card')
				.map((s) => s.props),
		[editor]
	)
	const shown = useValue('filter shown', () => boardDerived(editor).ranked.length, [editor])
	const total = useValue('filter total', () => boardDerived(editor).total, [editor])
	const o = filterOptions(cards, f, goal, new Date().getFullYear())
	const quality = o.peerReviewed || o.citedBy
	const best = o.best?.citedBy != null ? o.best : null

	return (
		<div
			className="pb-filterpop"
			role="dialog"
			aria-label="Filter"
			onKeyDown={(e) => {
				// the panel keeps its keys, so tldraw's shortcuts don't fire
				e.stopPropagation()
				if (e.key === 'Escape') onClose()
			}}
		>
			{o.fits.length > 0 && (
				<>
					<h6>Fit</h6>
					<div className="chips">
						{o.fits.map((k) => (
							<Chip key={k} on={f.fit.includes(k)} onClick={() => update({ fit: toggled(f.fit, [k]) })}>
								<span className="sw" style={{ background: FIT_COLOR[k] }} />
								{FIT_LABEL[k].replace(' fit', '')}
							</Chip>
						))}
					</div>
				</>
			)}
			{o.types.length > 0 && (
				<>
					<h6>Type</h6>
					<div className="chips">
						{o.types.map((chip) => (
							<Chip
								key={chip.label}
								on={chip.types.every((t) => f.types.includes(t))}
								onClick={() => update({ types: toggled(f.types, chip.types) })}
							>
								{chip.label}
							</Chip>
						))}
					</div>
				</>
			)}
			{quality && <h6>Quality</h6>}
			{o.peerReviewed && (
				<label className="pb-chk">
					<input type="checkbox" checked={f.peerReviewedOnly} onChange={(e) => update({ peerReviewedOnly: e.target.checked })} />
					Peer reviewed only (hides preprints)
				</label>
			)}
			{o.citedBy && (
				<>
					<div className="sub6">Cited at least</div>
					<div className="chips">
						{[0, ...CITED_AT_LEAST].map((n) => (
							<Chip key={n} on={f.minCitedBy === n} onClick={() => update({ minCitedBy: n })}>
								{n ? `${n}×` : 'Any'}
							</Chip>
						))}
					</div>
					<div className="mnote">
						New papers haven’t had time to be cited
						{best && `: the best match, ${nodeLabel(best.authors, best.year)}, has ${best.citedBy}`}. Counts from OpenAlex or
						Semantic Scholar.
					</div>
				</>
			)}
			{o.years.length > 0 && (
				<>
					<h6>Published</h6>
					<div className="chips">
						<Chip on={f.yearFrom === null} onClick={() => update({ yearFrom: null })}>
							Any time
						</Chip>
						{o.years.map((y) => (
							<Chip key={y} on={f.yearFrom === y} onClick={() => update({ yearFrom: y })}>
								Since {y}
							</Chip>
						))}
					</div>
				</>
			)}
			{o.showDiscarded && (
				<label className="pb-chk">
					<input type="checkbox" checked={f.showDiscarded} onChange={(e) => update({ showDiscarded: e.target.checked })} />
					Show discarded papers{o.discarded ? ` (${o.discarded})` : ''}
				</label>
			)}
			{!o.fits.length && !o.types.length && !quality && !o.years.length && !o.showDiscarded && (
				<div className="mnote">No suggestions to filter yet.</div>
			)}
			<div className="pfoot">
				Showing {shown} of {total} suggestions
				<button type="button" onClick={() => filters.set(DEFAULT_FILTERS)}>
					Clear
				</button>
			</div>
		</div>
	)
}
