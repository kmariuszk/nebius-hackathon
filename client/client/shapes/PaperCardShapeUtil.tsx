import { useState } from 'react'
import {
	HTMLContainer,
	Rectangle2d,
	ShapeUtil,
	useEditor,
	useValue,
	type Geometry2d,
	type SvgExportContext,
} from 'tldraw'
import { familyName, nodeLabel, sentenceCase } from '../../shared/display'
import {
	defaultPaperCardProps,
	paperCardMigrations,
	paperCardProps,
	type PaperCardShape,
} from '../../shared/shapes'
import { currentGoal, litPaperIds, openPaperId, paperMoreOpen } from '../viewerState'
import { arrivalDelay } from './arrivals'
import { boardDerived, CARD_H, CARD_W, cardOffset, FIT_LABEL, isSaved, loopPath, seedOf, tilt } from './card'
import './paperCard.css'

// A paper on the board, drawn as a v6 card (docs/mockups/flashcard-v6.html): saved papers are
// pinned, new suggestions are taped up and numbered in the agent's reading order.

export class PaperCardShapeUtil extends ShapeUtil<PaperCardShape> {
	static override type = 'paper-card' as const
	static override props = paperCardProps
	static override migrations = paperCardMigrations

	override getDefaultProps() {
		return defaultPaperCardProps('')
	}

	override getGeometry(shape: PaperCardShape): Geometry2d {
		const o = cardOffset(shape)
		return new Rectangle2d({ x: o.x, y: o.y, width: CARD_W, height: CARD_H, isFilled: true })
	}

	override getIndicatorPath(shape: PaperCardShape) {
		const o = cardOffset(shape)
		const path = new Path2D()
		path.roundRect(o.x, o.y, CARD_W, CARD_H, 3)
		return path
	}

	override component(shape: PaperCardShape) {
		return <PaperCard shape={shape} />
	}

	override toSvg(shape: PaperCardShape, _ctx: SvgExportContext) {
		const o = cardOffset(shape)
		return (
			<g transform={`translate(${o.x} ${o.y})`}>
				<rect width={CARD_W} height={CARD_H} rx={3} fill="#fffdf7" stroke="#d3d1c9" />
				<text x={12} y={40} fontSize={15} fontWeight={700} fill="#0b0b0b" fontFamily="system-ui, sans-serif">
					{nodeLabel(shape.props.authors, shape.props.year)}
				</text>
			</g>
		)
	}

	// opens the paper's widgets for this viewer; clicking the open paper again shows or hides "More"
	override onClick(shape: PaperCardShape) {
		const { paperId } = shape.props
		if (openPaperId.get() === paperId) {
			paperMoreOpen.set(!paperMoreOpen.get())
		} else {
			openPaperId.set(paperId)
			paperMoreOpen.set(false)
		}
	}

	// a quick second click arrives as a double click; the empty change stops tldraw from
	// starting a text shape on top of the card
	override onDoubleClick(shape: PaperCardShape) {
		this.onClick(shape)
		return { id: shape.id, type: shape.type }
	}

	override canResize() {
		return false
	}
	override isAspectRatioLocked() {
		return true
	}
	override hideResizeHandles() {
		return true
	}
	override hideRotateHandle() {
		return true
	}
	override hideSelectionBoundsFg() {
		return true
	}
	override getAriaDescriptor(shape: PaperCardShape) {
		return `${nodeLabel(shape.props.authors, shape.props.year)}: ${shape.props.title}`
	}
}

const BOOK = (
	<svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true">
		<path d="M1 1h8v10L5 8 1 11z" fill="currentColor" />
	</svg>
)

function PaperCard({ shape }: { shape: PaperCardShape }) {
	const editor = useEditor()
	const { paperId, scores, authors, year, title, status, working } = shape.props
	// per-viewer state: changing it re-renders this browser only
	const fit = useValue('paper fit', () => scores[currentGoal.get()]?.fit ?? null, [scores])
	const lit = useValue('paper lit', () => litPaperIds.get().includes(paperId), [paperId])
	const open = useValue('paper open', () => openPaperId.get() === paperId, [paperId])
	const rank = useValue('paper rank', () => boardDerived(editor).ranks.get(paperId) ?? null, [editor, paperId])
	const note = useValue('paper note', () => boardDerived(editor).notes.get(paperId) ?? null, [editor, paperId])
	const [delay, setDelay] = useState(() => arrivalDelay(shape.id))

	const saved = isSaved(shape)
	const o = cardOffset(shape)
	const discarded = status === 'discarded'
	const name = authors[0] ? familyName(authors[0]) : nodeLabel(authors, null)
	const label = `${name} ${year ?? ''}`.trim()
	const fs = label.length > 17 ? 13 : label.length > 15 ? 14.5 : 15
	const angle = lit ? 0 : tilt(paperId)
	const badge = badgeOf(shape)
	const cx = CARD_W / 2

	return (
		<HTMLContainer
			className={delay === null ? undefined : 'pc-arrive'}
			style={delay === null ? undefined : { animationDelay: `${delay}ms` }}
			onAnimationEnd={(e) => e.target === e.currentTarget && setDelay(null)}
		>
			<div
				className={`pb-wrap${discarded ? ' gone' : ''}`}
				style={{ left: o.x, top: o.y, width: CARD_W, height: CARD_H }}
			>
				<div className="pb-tilt" style={{ transform: `rotate(${angle.toFixed(2)}deg)` }}>
					<div className={`pb-c ${saved ? 'saved' : 'sugg'}${open ? ' sel' : ''}${lit ? ' pulse' : ''}`}>
						<div className="pb-top">
							{saved ? (
								<>
									{BOOK}
									In your collection
								</>
							) : (
								<>
									Suggested{fit && <> · <b>{FIT_LABEL[fit]}</b></>}
								</>
							)}
						</div>
						<div className="pb-name" style={{ fontSize: fs }}>
							<span className="a">{name}</span>
							{year != null && <span className="y">{year}</span>}
						</div>
						<div className="pb-ttl">{sentenceCase(title)}</div>
					</div>
					{!saved && (
						<svg className="pb-over" width={CARD_W} height={CARD_H} overflow="visible" aria-hidden="true">
							<rect className="pb-tapebit" x={cx - 29} y={-8} width={58} height={16} transform={`rotate(-3 ${cx} 0)`} filter="url(#pbTape)" />
							{rank != null && (
								<g className="pb-rank">
									<path d={loopPath(2, 1, 14, 13, seedOf(paperId) + rank)} />
									<text x={2} y={7.5} textAnchor="middle">
										{rank}
									</text>
								</g>
							)}
						</svg>
					)}
				</div>
				<svg className="pb-over" width={CARD_W} height={CARD_H} overflow="visible" aria-hidden="true">
					{open && <path className="pb-loop" pathLength={1} d={loopPath(cx, CARD_H / 2, CARD_W / 2 + 16, CARD_H / 2 + 16, seedOf(paperId))} />}
					{saved && (
						<g transform={`translate(${cx} 1)`}>
							<circle cx={1.5} cy={3} r={5} fill="rgba(40,20,5,.32)" filter="url(#pbBlur)" />
							<circle r={6} fill="url(#pbPin)" />
							<circle cx={-1.8} cy={-2} r={1.5} fill="#fff" opacity={0.7} />
						</g>
					)}
					{badge && <Badge {...badge} />}
					{working && !badge && <Badge text="Reading…" cls="read" />}
					{note && !open && (
						<g className="pb-agentnote" transform={`translate(2 ${CARD_H + 19})`}>
							<g transform="translate(0 -11)">
								<rect className="pb-note-ico" x={0.7} y={3} width={11} height={8} rx={2.4} />
								<circle cx={4.3} cy={7} r={0.9} fill="var(--pb-marker)" />
								<circle cx={8.3} cy={7} r={0.9} fill="var(--pb-marker)" />
								<path className="pb-note-ico" d="M6.2 3V.8" />
							</g>
							<text className="pb-note" x={17} y={0}>
								{note}
							</text>
						</g>
					)}
				</svg>
			</div>
		</HTMLContainer>
	)
}

type BadgeCls = '' | 'gone' | 'read' | 'split' | 'kept'

function badgeOf(shape: PaperCardShape): { text: string; cls: BadgeCls } | null {
	const { status, working, kind } = shape.props
	if (status === 'discarded') return { text: 'Discarded', cls: 'gone' }
	if (working) return { text: 'Reading…', cls: 'read' }
	if (status === 'contested') return { text: 'Split vote', cls: 'split' }
	if (status === 'new') return { text: 'New', cls: '' }
	if (kind === 'kept') return { text: '✓ Kept', cls: 'kept' }
	return null
}

function Badge({ text, cls }: { text: string; cls: BadgeCls }) {
	const read = cls === 'read'
	const w = text.length * 6.1 + (read ? 30 : 16)
	const x = Math.max(CARD_W / 2 + 12, CARD_W - w - 8)
	return (
		<g className={`pb-badge ${cls}`} transform={`translate(${x} -14)`}>
			<rect width={w} height={18} rx={9} />
			{read && <circle className="sp" cx={11} cy={9} r={4} />}
			<text x={read ? 20 : w / 2} y={12.6} textAnchor={read ? 'start' : 'middle'}>
				{text}
			</text>
		</g>
	)
}
