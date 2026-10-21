import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { nodeLabel, sentenceCase, shortAuthors } from '../../shared/display.ts'
import type { Fit, GlanceStep, PaperQuote } from '../../shared/paperCard.ts'
import { chatBus } from '../chat/chatBus.ts'
import { openPaperId, paperMoreOpen, type Tour } from '../viewerState.ts'
import { addPinnedNote } from './boardWrites.ts'
import { sourceLabel, splitClaims, type ClaimEvidence } from './claims.ts'
import { useWidgets, type LinkedPaper, type WidgetsApi } from './context.ts'
import { emptyState } from './emptyStates.ts'
import { glanceIcon, RELATION_LABEL, type GlanceIcon } from './glance.ts'
import { runTour } from './tour.ts'
import { castVote, myVote, type Vote } from './votes.ts'

// The widgets around an open paper (v5, docs/mockups/flashcard-v5.html), each answering one
// question. They read the card's props live, so each part fills in as the agent writes it.

export const FIT_COLOR: Record<Fit, string> = { high: '#104281', medium: '#2a78d6', low: '#86b6ef' }
export const UNSCORED = '#c3c2b7'
const FIT_LABEL: Record<Fit, string> = { high: 'High fit', medium: 'Medium fit', low: 'Low fit' }
const GOAL_LABEL: Record<string, string> = { 'new-findings': 'new findings', methods: 'methods to reuse' }
const STATUS_LABEL = { new: 'New', kept: 'Kept', contested: 'Split vote', discarded: 'Discarded' }

export const goalLabel = (goal: string) => GOAL_LABEL[goal] ?? goal.replace(/-/g, ' ')

export interface NoteItem {
	id: string
	text: string
	author: string | null
}

function Widget({ k, className = '', style, children }: { k: string; className?: string; style?: CSSProperties; children: ReactNode }) {
	const { measure, limits, pop, peekKey } = useWidgets()
	const limit = limits[k]
	const classes = ['w', className, peekKey === k && 'peekself', limit !== undefined && 'limited'].filter(Boolean).join(' ')
	return (
		<section className={classes} data-k={k} style={{ ...style, ...pop(k), maxHeight: limit }}>
			<div className="wi" ref={measure(k)}>
				{children}
			</div>
		</section>
	)
}

function Head({ children, ai = false, sub }: { children: ReactNode; ai?: boolean; sub?: ReactNode }) {
	return (
		<div className="wh">
			{children}
			{ai && <span className="ai">AI</span>}
			{sub !== undefined && sub !== null && <span className="wsub">{sub}</span>}
		</div>
	)
}

const Spin = () => <span className="spin" />

const openUrl = (url: string) => window.open(url, '_blank', 'noopener,noreferrer')

/* ---------- what is it: the title, on top ---------- */

export function TitleWidget() {
	const { shape, memberId } = useWidgets()
	const p = shape.props
	const kick: ReactNode[] = []
	if (p.kind === 'seed' || p.kind === 'kept') {
		kick.push(
			<>
				<span className="sq" />
				<b>In your collection</b>
			</>,
			p.kind === 'seed' ? 'Seed' : p.keepBy.includes(memberId) ? 'Kept by you' : 'Kept'
		)
	} else if (p.status === 'discarded') kick.push('Discarded')
	if (p.type === 'preprint') kick.push(<span className="flag">Preprint</span>)
	if (p.type === 'review') kick.push(<b>Review</b>)
	const byline = [shortAuthors(p.authors), p.venue, p.year ?? ''].filter(Boolean).join(' · ')
	const title = sentenceCase(p.title)

	return (
		<Widget k="title" className="title-w">
			{kick.length > 0 && (
				<div className="kick">
					{kick.map((part, i) => (
						<Fragment key={i}>
							{i > 0 && <span className="sep">·</span>}
							{part}
						</Fragment>
					))}
				</div>
			)}
			<h2 className="ttl">
				{!title ? <div className="skel" /> : p.url ? <a href={p.url} target="_blank" rel="noreferrer">{title}</a> : title}
			</h2>
			<div className="meta">
				<span>{byline}</span>
				{p.url && (
					<a href={p.url} target="_blank" rel="noreferrer">
						Open paper ↗
					</a>
				)}
			</div>
		</Widget>
	)
}

/* ---------- why it matters to you, on the right ---------- */

export function WhyWidget() {
	const { shape, goal } = useWidgets()
	const p = shape.props
	const score = p.scores[goal]
	const color = score ? FIT_COLOR[score.fit] : UNSCORED
	const { segments } = useMemo(() => splitClaims(p.oneLine, p.claims, p.quotes), [p.oneLine, p.claims, p.quotes])
	const state = emptyState(p, 'why')

	if (state.kind === 'seed') {
		return (
			<Widget k="why" className="why-w" style={{ '--fit': 'var(--ink)' } as CSSProperties}>
				<Head>Why it matters to you</Head>
				<p className="why">{state.text}</p>
			</Widget>
		)
	}
	return (
		<Widget k="why" className="why-w" style={{ '--fit': color } as CSSProperties}>
			<Head ai={state.kind !== 'ended'}>Why it matters to you</Head>
			<div className="fitrow">
				<span className="dot" style={{ background: color }} />
				{score ? (
					<>
						<b>{FIT_LABEL[score.fit]}</b> for {goalLabel(goal)}
					</>
				) : (
					<>Not scored yet for {goalLabel(goal)}</>
				)}
				<span className="sep">·</span>
				{STATUS_LABEL[p.status]}
			</div>
			{segments.length > 0 && (
				<p className="why">
					{segments.map((s, i) => (s.claim ? <Claim key={i} text={s.text} claim={s.claim} /> : <Fragment key={i}>{s.text}</Fragment>))}
				</p>
			)}
			{state.kind === 'working' && (
				<div className="reading">
					<Spin />
					Still reading. The rest fills in as it’s ready.
				</div>
			)}
			{state.kind === 'ended' && <div className="meta ended">{state.text}</div>}
		</Widget>
	)
}

interface SeedInfo {
	paperId: string
	label: string
	cites: 'in' | 'out' | null
}

/** The seeds a "three of your seeds" claim means: those linked to the paper, else every seed. */
function seedsOf(api: WidgetsApi): SeedInfo[] {
	const linked = api.linked.filter((l) => l.kind === 'seed')
	if (linked.length) return linked
	return api.editor.getCurrentPageShapes().flatMap((s) =>
		s.type === 'paper-card' && s.props.kind === 'seed'
			? [{ paperId: s.props.paperId, label: nodeLabel(s.props.authors, s.props.year), cites: null }]
			: []
	)
}

function SeedsPop({ seeds, linked }: { seeds: SeedInfo[]; linked: boolean }) {
	const citing = seeds.length > 0 && seeds.every((s) => s.cites === 'out')
	const head = !linked ? 'Your seeds' : citing ? `Cites ${seeds.length} of your seeds` : `Linked to ${seeds.length} of your seeds`
	return (
		<>
			<div className="pm">{seeds.length ? head : 'There are no seeds on the board yet.'}</div>
			{seeds.length > 0 && <div className="seeds">{seeds.map((s) => s.label).join(' · ')}</div>}
			{citing && <div className="pm">A citation is a link, not agreement.</div>}
		</>
	)
}

export function QuotesPop({ quotes, unknown }: { quotes: PaperQuote[]; unknown: string[] }) {
	return (
		<>
			{quotes.map((q) => (
				<div className="pq" key={q.id}>
					<blockquote>“{q.text}”</blockquote>
					<div className="pm">
						{q.verified ? (
							<>
								<b>✓</b> Word for word
								{q.url && (
									<>
										{' · '}
										<a href={q.url} target="_blank" rel="noreferrer">
											{sourceLabel(q.url)} ↗
										</a>
									</>
								)}
							</>
						) : (
							<>
								<b className="w">⚠</b> Not found word for word in the {q.source || 'paper'}.
							</>
						)}
					</div>
				</div>
			))}
			{unknown.length > 0 && (
				<div className="pm">
					<b className="w">⚠</b> {unknown.length === 1 ? 'A quote it points to isn’t' : 'Quotes it points to aren’t'} on the card.
				</div>
			)}
			{!quotes.length && !unknown.length && (
				<div className="pm">
					<b className="w">⚠</b> Nothing backs this up yet.
				</div>
			)}
		</>
	)
}

function Claim({ text, claim }: { text: string; claim: ClaimEvidence }) {
	const api = useWidgets()
	const onEnter = (e: MouseEvent<HTMLElement>) => {
		if (claim.seeds) {
			const linked = api.linked.some((l) => l.kind === 'seed')
			const seeds = seedsOf(api)
			api.showPop(
				e.currentTarget,
				<>
					<SeedsPop seeds={seeds} linked={linked} />
					{(claim.quotes.length > 0 || claim.unknown.length > 0) && <QuotesPop quotes={claim.quotes} unknown={claim.unknown} />}
				</>,
				{ key: 'why', paperIds: seeds.map((s) => s.paperId) }
			)
		} else api.showPop(e.currentTarget, <QuotesPop quotes={claim.quotes} unknown={claim.unknown} />)
	}
	const source = claim.quotes.find((q) => q.verified && q.url)
	return (
		<>
			<span
				className={`ev-u${claim.verified ? '' : ' unv'}`}
				onMouseEnter={onEnter}
				onMouseLeave={api.hidePop}
				onClick={source ? () => openUrl(source.url) : undefined}
			>
				{text}
			</span>
			{!claim.verified && (
				<span className="wmark" title="Not found word for word">
					⚠
				</span>
			)}
		</>
	)
}

/* ---------- suggestions linked to a seed, in the same place ---------- */

export function LinkedWidget() {
	const api = useWidgets()
	const rows = api.linked.filter((l) => l.kind === 'suggestion')
	return (
		<Widget k="linked" className="why-w" style={{ '--fit': 'var(--ink)' } as CSSProperties}>
			<Head sub={rows.length}>Suggestions linked to it</Head>
			{rows.map((r) => (
				<LinkedRow key={r.shapeId} row={r} />
			))}
			{rows.length === 0 && <div className="meta">None yet.</div>}
		</Widget>
	)
}

function LinkedRow({ row }: { row: LinkedPaper }) {
	const api = useWidgets()
	return (
		<button
			className="linked"
			onClick={() => openPaperId.set(row.paperId)}
			onMouseEnter={() => api.peek('linked', [row.paperId])}
			onMouseLeave={() => api.peek(null)}
		>
			<span className="sw" style={{ background: row.fit ? FIT_COLOR[row.fit] : UNSCORED }} />
			<b>{row.label}</b>
			<span className="r">{row.relation}</span>
		</button>
	)
}

/* ---------- the paper at a glance, on the left ---------- */

export function GlanceWidget() {
	const { shape } = useWidgets()
	const { glance, quotes } = shape.props
	const state = emptyState(shape.props, 'glance')
	if (state.kind === 'hidden') return null
	return (
		<Widget k="glance" className="glance-w">
			<Head ai={state.kind !== 'ended'}>The paper at a glance</Head>
			{state.kind === 'ended' ? (
				<div className="meta">{state.text}</div>
			) : glance.length === 0 ? (
				<>
					<div className="reading first">
						<Spin />
						Reading the paper…
					</div>
					<div className="skel" />
					<div className="skel" style={{ width: '82%' }} />
					<div className="skel" style={{ width: '64%' }} />
				</>
			) : (
				<>
					<ol className="flow">
						{glance.map((step, i) => (
							<Step key={i} step={step} quotes={quotes} />
						))}
					</ol>
					<div className="gfoot">Same or new compared with your seeds. Hover a step to see the sentence it comes from.</div>
				</>
			)}
		</Widget>
	)
}

function Step({ step, quotes }: { step: GlanceStep; quotes: PaperQuote[] }) {
	const api = useWidgets()
	const icon = glanceIcon(step.label)
	const quote = step.quoteId ? quotes.find((q) => q.id === step.quoteId) : undefined
	const hover = step.quoteId !== null
	return (
		<li
			className={`gstep${icon === 'finding' ? ' fin' : ''}${hover ? ' has-q' : ''}`}
			onMouseEnter={
				hover
					? (e) => api.showPop(e.currentTarget, <QuotesPop quotes={quote ? [quote] : []} unknown={quote ? [] : [step.quoteId!]} />)
					: undefined
			}
			onMouseLeave={hover ? api.hidePop : undefined}
			onClick={quote?.verified && quote.url ? () => openUrl(quote.url) : undefined}
		>
			<span className="gi">
				<GlanceSvg icon={icon} />
			</span>
			<div>
				<div className="gk">{step.label}</div>
				<div className="gv">{step.text}</div>
			</div>
			{step.relation && <span className={`s ${step.relation}`}>{RELATION_LABEL[step.relation]}</span>}
		</li>
	)
}

function GlanceSvg({ icon }: { icon: GlanceIcon }) {
	switch (icon) {
		case 'samples':
			return <svg viewBox="0 0 16 16"><path d="M5.5 1.8h5M6.5 1.8v10a1.5 1.5 0 0 0 3 0v-10M6.5 7.2h3" /></svg>
		case 'method':
			return <svg viewBox="0 0 16 16"><path d="M2 3h12l-4.5 5.2v4.8l-3-1.6V8.2z" strokeLinejoin="round" /></svg>
		case 'readout':
			return <svg viewBox="0 0 16 16"><path d="M3 13.5V9M6.3 13.5V3.5M9.6 13.5V7M13 13.5V5" /></svg>
		case 'compare':
			return (
				<svg viewBox="0 0 16 16">
					<path d="M8 2.5v11M4.5 13.5h7M2.8 4.5h10.4M2.8 4.5 1.2 9h3.2zM13.2 4.5 11.6 9h3.2z" strokeLinejoin="round" />
				</svg>
			)
		case 'check':
			return (
				<svg viewBox="0 0 16 16">
					<circle cx="8" cy="5" r="2.6" />
					<path d="M3 14c.6-3 2.6-4.6 5-4.6s4.4 1.6 5 4.6" />
				</svg>
			)
		case 'scope':
			return (
				<svg viewBox="0 0 16 16">
					<path d="M2 3.5h4.5A1.5 1.5 0 0 1 8 5v8.5a1.5 1.5 0 0 0-1.5-1.5H2zM14 3.5H9.5A1.5 1.5 0 0 0 8 5v8.5a1.5 1.5 0 0 1 1.5-1.5H14z" strokeLinejoin="round" />
				</svg>
			)
		case 'finding':
			return (
				<svg viewBox="0 0 16 16">
					<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="currentColor" stroke="none" />
				</svg>
			)
	}
}

/* ---------- a figure from the paper, under the diagram ---------- */

export function FigureWidget() {
	const { shape, openFigure } = useWidgets()
	const { figure } = shape.props
	const [failed, setFailed] = useState<string | null>(null)
	const state = emptyState(shape.props, 'figure')
	if (state.kind === 'hidden') return null
	if (state.kind === 'ended') {
		return (
			<Widget k="figure" className="fig-w none">
				<div className="nofig">{state.text}</div>
			</Widget>
		)
	}
	if (!figure) {
		return (
			<Widget k="figure" className="fig-w">
				<div className="figimg pending">
					<div className="reading">
						<Spin />
						Finding the most relevant figure…
					</div>
				</div>
			</Widget>
		)
	}
	const broken = failed === figure.imageUrl
	return (
		<Widget k="figure" className="fig-w">
			{!broken && (
				<button className="figimg" onClick={openFigure} title="Open the figure">
					<img src={figure.imageUrl} alt={`${figure.label || 'Figure'} from the paper`} onError={() => setFailed(figure.imageUrl)} />
				</button>
			)}
			<div className="figcap">
				<b>{figure.label || 'Figure'}</b> · from the paper{broken && ' (the image didn’t load)'}
				{figure.caption &&
					(figure.captionByAi ? (
						<div className="fwhy">
							<span className="ai">AI</span>
							{figure.caption}
						</div>
					) : (
						<div className="fcap">{figure.caption}</div>
					))}
			</div>
		</Widget>
	)
}

/* ---------- actions, under the node ---------- */

/** `onVoted` runs once a vote is saved: PaperWidgets decides what opens next. `tour` is set while Catch me up is on this paper. */
export function ActionsWidget({ tour, onVoted }: { tour: Tour | null; onVoted(decision: Vote): void }) {
	const api = useWidgets()
	const { shape, boardId, memberId, more } = api
	const p = shape.props
	const mine = myVote(p, memberId)
	const label = nodeLabel(p.authors, p.year)
	const collection = p.kind === 'seed' || p.kind === 'kept'
	const [sending, setSending] = useState(false)

	// the card changes when the board service's write reaches this browser through sync
	const vote = async (v: Vote) => {
		let before: Vote
		// a vote on the tour's last paper ends it
		const caughtUp = tour !== null && v !== null && tour.i === tour.steps.length - 1 ? ' You’re caught up.' : ''
		setSending(true)
		try {
			before = await castVote(boardId, p, memberId, v)
		} catch (e) {
			api.toast({ text: `Your vote wasn’t saved: ${(e as Error).message}` })
			return
		} finally {
			setSending(false)
		}
		const undo = () =>
			void castVote(boardId, p, memberId, before).then(
				() => v === 'discard' && openPaperId.set(p.paperId),
				(e: Error) => api.toast({ text: `Undo wasn’t saved: ${e.message}` })
			)
		if (v === 'keep') api.toast({ text: `Kept ${label} for everyone on the board.${caughtUp}`, undo })
		else if (v === 'discard') api.toast({ text: `Discarded ${label}. It’s hidden unless you show discarded papers.${caughtUp}`, undo })
		else api.toast({ text: `${label} is back on the board.`, undo })
		onVoted(v)
	}

	// the chat opens (connecting if it has to) and sends it
	const findMore = () => chatBus.ask({ text: `Find more papers like ${label}: “${sentenceCase(p.title)}”` })

	let actions: ReactNode
	if (collection) {
		actions = (
			<button className="btn" onClick={findMore}>
				Find more like this
			</button>
		)
	} else if (p.status === 'discarded' && mine === 'discard') {
		actions = (
			<button className="btn" onClick={() => vote(null)} disabled={sending}>
				Bring it back
			</button>
		)
	} else {
		actions = (
			<>
				<button className="btn" onClick={() => vote('discard')} disabled={sending || mine === 'discard'} aria-pressed={mine === 'discard'}>
					Discard
				</button>
				<button className="btn primary" onClick={() => vote('keep')} disabled={sending || mine === 'keep'} aria-pressed={mine === 'keep'}>
					Keep
				</button>
			</>
		)
	}

	return (
		<Widget k="actions" className="dock">
			{tour && <TourBar tour={tour} />}
			<div className="dbody">
				{p.status === 'contested' && (
					<div className="votes">
						<span className="split">Split vote:</span>
						{voteSummary(p.keepBy, p.discardBy, memberId)}
					</div>
				)}
				<div className="drow">
					{!tour && (
						<button className="more" onClick={api.close} title="Close (Esc)">
							× Close
						</button>
					)}
					{p.kind !== 'seed' && (
						<button className={`more${more ? ' open' : ''}`} onClick={() => paperMoreOpen.set(!more)}>
							{more ? 'Less' : 'More'} <span className="chev">⌄</span>
						</button>
					)}
					<span className="grow" />
					{actions}
				</div>
			</div>
		</Widget>
	)
}

/** Catch me up's strip on top of the actions (v6 demo board): where you are, the paper's line, and the way on. */
function TourBar({ tour }: { tour: Tour }) {
	const api = useWidgets()
	const last = tour.i === tour.steps.length - 1
	const done = () => {
		runTour({ type: 'end' })
		api.toast({ text: 'You’re caught up.' })
	}
	return (
		<div className="tour">
			<div className="r1">
				<span className="av">
					<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
						<rect x="2" y="4.5" width="12" height="9" rx="3" fill="none" stroke="#fff" strokeWidth="1.5" />
						<circle cx="6" cy="9" r="1.2" fill="#fff" />
						<circle cx="10" cy="9" r="1.2" fill="#fff" />
						<path d="M8 4.5V2" stroke="#fff" strokeWidth="1.5" />
					</svg>
				</span>
				{tour.title.toUpperCase()} · {tour.i + 1} OF {tour.steps.length}
				<span className="dots">
					{tour.steps.map((s, k) => (
						<i key={s.paperId} className={k === tour.i ? 'on' : undefined} />
					))}
				</span>
				<span className="nav">
					<button onClick={() => runTour({ type: 'prev' })} disabled={tour.i === 0} title="Previous">
						‹
					</button>
					<button onClick={last ? done : () => runTour({ type: 'next' })}>{last ? 'Done' : 'Next ›'}</button>
					<button onClick={() => runTour({ type: 'end' })} title="End the catch-up">
						×
					</button>
				</span>
			</div>
			<div className="say">{tour.steps[tour.i].line}</div>
		</div>
	)
}

function voteSummary(keepBy: string[], discardBy: string[], memberId: string) {
	const part = (ids: string[], verb: string) => {
		const others = ids.filter((m) => m !== memberId).length
		const you = ids.includes(memberId)
		const who = [you && 'you', others && `${others} other${others > 1 ? 's' : ''}`].filter(Boolean).join(' and ')
		return who ? `${who.charAt(0).toUpperCase()}${who.slice(1)} ${verb} it` : ''
	}
	return [part(keepBy, 'kept'), part(discardBy, 'discarded')].filter(Boolean).join(' · ')
}

/* ---------- team notes ---------- */

export function NotesWidget({ notes }: { notes: NoteItem[] }) {
	const api = useWidgets()
	const [text, setText] = useState('')
	const input = useRef<HTMLInputElement>(null)
	useEffect(() => {
		if (api.noteDraft) input.current?.focus()
	}, [api.noteDraft])
	const add = () => {
		const t = text.trim()
		if (!t) return
		addPinnedNote(api.editor, api.shape, t, api.memberId)
		setText('')
		api.setNoteDraft(false)
	}
	return (
		<Widget k="notes" className="notes-w">
			<Head sub={notes.length || undefined}>Team notes</Head>
			{notes.map((n) => (
				<div className="nitem" key={n.id}>
					{n.text || <i className="muted">Empty note</i>}
					{n.author && (
						<div className="who">
							<span className="dot" style={{ background: n.author === 'Agent' ? 'var(--ink)' : 'var(--fit-medium)' }} />
							{n.author}
						</div>
					)}
				</div>
			))}
			<input
				ref={input}
				className="addnote"
				value={text}
				placeholder="Add a note. Everyone on the board sees it."
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter') add()
					if (e.key === 'Escape') e.currentTarget.blur()
				}}
				onBlur={() => !text.trim() && api.setNoteDraft(false)}
			/>
		</Widget>
	)
}

/* ---------- what supports this, under More ---------- */

export function EvidenceWidget() {
	const api = useWidgets()
	const p = api.shape.props
	const sources = [...new Set(p.quotes.map((q) => q.source).filter(Boolean))]
	const seeds = api.linked.filter((l) => l.kind === 'seed')
	const citesAll = seeds.length > 0 && seeds.every((s) => s.cites === 'out')
	const cited = p.citedBy === null ? '' : p.citedBy ? `Cited ${p.citedBy.toLocaleString('en')}×.` : 'Not cited yet.'

	return (
		<Widget k="evidence" className="ev-w">
			<Head sub={sources.length === 1 ? `quotes from the ${sources[0]}` : undefined}>What supports this</Head>
			{p.quotes.map((q) => (
				<div className={`q${q.verified ? '' : ' unv'}`} key={q.id}>
					<blockquote>“{q.text}”</blockquote>
					<div className="qm">
						{q.verified ? (
							<>
								<span className="okt">✓ Word for word</span>
								{q.url && (
									<>
										{' · '}
										<a href={q.url} target="_blank" rel="noreferrer">
											{sourceLabel(q.url)} ↗
										</a>
									</>
								)}
							</>
						) : (
							<span className="bad">⚠ Not found word for word in the {q.source || 'paper'}.</span>
						)}
					</div>
				</div>
			))}
			{p.quotes.length === 0 && <div className="meta">{p.working ? 'The agent is still collecting quotes.' : 'No quotes on this card yet.'}</div>}
			{seeds.length > 0 && (
				<>
					<div className="h5">On your board</div>
					<div className="seedlinks">
						{citesAll ? `Cites ${seeds.length} of your seeds: ` : `Linked to ${seeds.length} of your seeds: `}
						{seeds.map((s, i) => (
							<Fragment key={s.shapeId}>
								{i > 0 && ', '}
								<button
									onClick={() => openPaperId.set(s.paperId)}
									onMouseEnter={() => api.peek('evidence', [s.paperId])}
									onMouseLeave={() => api.peek(null)}
								>
									{s.label}
								</button>
							</Fragment>
						))}
					</div>
				</>
			)}
			{p.gaps.length > 0 && (
				<>
					<div className="h5">Couldn’t check</div>
					<ul className="gaps">
						{p.gaps.map((g, i) => (
							<li key={i}>{g}</li>
						))}
					</ul>
				</>
			)}
			{(p.foundBy.length > 0 || cited) && (
				<div className="prov">
					{p.foundBy.length > 0 && `Found through ${p.foundBy.join(', ')}. `}
					{cited}
				</div>
			)}
		</Widget>
	)
}
