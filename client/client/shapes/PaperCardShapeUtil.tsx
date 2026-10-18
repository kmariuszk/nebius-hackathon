import { useState, type SVGProps } from 'react'
import {
	Circle2d,
	HTMLContainer,
	Rectangle2d,
	ShapeUtil,
	useValue,
	type Geometry2d,
	type SvgExportContext,
} from 'tldraw'
import { nodeLabel } from '../../shared/display'
import type { Fit } from '../../shared/paperCard'
import {
	defaultPaperCardProps,
	paperCardMigrations,
	paperCardProps,
	type PaperCardShape,
} from '../../shared/shapes'
import { currentGoal, litPaperIds, openPaperId, paperMoreOpen } from '../viewerState'
import { arrivalDelay } from './arrivals'
import './paperCard.css'

// The node of a paper on the board, drawn as in the v5 mockup (docs/mockups/flashcard-v5.html).

const INK = '#0b0b0b'
const INK2 = '#52514e'
const WARN = '#d99a00'
const FIT_COLOR: Record<Fit, string> = { high: '#104281', medium: '#2a78d6', low: '#86b6ef' }
const UNSCORED = '#c3c2b7'
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif'

const isSquare = (shape: PaperCardShape) => shape.props.kind !== 'suggestion'

export class PaperCardShapeUtil extends ShapeUtil<PaperCardShape> {
	static override type = 'paper-card' as const
	static override props = paperCardProps
	static override migrations = paperCardMigrations

	override getDefaultProps() {
		return defaultPaperCardProps('')
	}

	// the node only; its label hangs below, outside the hit area, as in v5
	override getGeometry(shape: PaperCardShape): Geometry2d {
		const { w, h } = shape.props
		if (isSquare(shape)) return new Rectangle2d({ width: w, height: h, isFilled: true })
		const r = Math.min(w, h) / 2
		return new Circle2d({ radius: r, x: w / 2 - r, y: h / 2 - r, isFilled: true })
	}

	override getIndicatorPath(shape: PaperCardShape) {
		const { w, h } = shape.props
		const path = new Path2D()
		if (isSquare(shape)) path.roundRect(0, 0, w, h, 8)
		else path.arc(w / 2, h / 2, Math.min(w, h) / 2, 0, Math.PI * 2)
		return path
	}

	override component(shape: PaperCardShape) {
		return <PaperNode shape={shape} />
	}

	override toSvg(shape: PaperCardShape, ctx: SvgExportContext) {
		const fit = shape.props.scores[currentGoal.get()]?.fit ?? null
		return <NodeSvg shape={shape} fit={fit} lit={false} open={false} halo={ctx.isDarkMode ? '#101011' : '#fff'} />
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
	// starting a text shape on top of the node
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

function PaperNode({ shape }: { shape: PaperCardShape }) {
	const { paperId, scores } = shape.props
	// per-viewer state: changing it re-renders this browser only
	const fit = useValue('paper fit', () => scores[currentGoal.get()]?.fit ?? null, [scores])
	const lit = useValue('paper lit', () => litPaperIds.get().includes(paperId), [paperId])
	const open = useValue('paper open', () => openPaperId.get() === paperId, [paperId])
	const [delay, setDelay] = useState(() => arrivalDelay(shape.id))

	return (
		<HTMLContainer
			className={delay === null ? undefined : 'pc-arrive'}
			style={delay === null ? undefined : { animationDelay: `${delay}ms` }}
			onAnimationEnd={(e) => e.target === e.currentTarget && setDelay(null)}
		>
			<svg width={shape.props.w} height={shape.props.h} overflow="visible" style={{ display: 'block' }}>
				<NodeSvg shape={shape} fit={fit} lit={lit} open={open} halo="var(--tl-color-background, #fff)" animated />
			</svg>
		</HTMLContainer>
	)
}

interface NodeSvgProps {
	shape: PaperCardShape
	fit: Fit | null
	lit: boolean
	open: boolean
	/** The outline that keeps labels readable over links. */
	halo: string
	animated?: boolean
}

function NodeSvg({ shape, fit, lit, open, halo, animated = false }: NodeSvgProps) {
	const { w, h, kind, status, working, authors, year } = shape.props
	const square = isSquare(shape)
	const cx = w / 2
	const cy = h / 2
	const r = Math.min(w, h) / 2
	const discarded = status === 'discarded'
	const sub = discarded ? 'Discarded' : working ? 'Agent is reading…' : ''
	const ring = (pad: number, props: SVGProps<SVGRectElement> & SVGProps<SVGCircleElement>) =>
		square ? (
			<rect x={-pad} y={-pad} width={w + 2 * pad} height={h + 2 * pad} rx={8 + pad / 2} fill="none" {...props} />
		) : (
			<circle cx={cx} cy={cy} r={r + pad} fill="none" {...props} />
		)
	// the split-vote mark sits on the lower right edge
	const split = square ? { x: w - 1, y: h - 1 } : { x: cx + r * 0.71, y: cy + r * 0.71 }
	const text = { textAnchor: 'middle', strokeWidth: 4, strokeLinejoin: 'round', paintOrder: 'stroke' } as const

	return (
		<g opacity={discarded ? 0.35 : 1} style={{ fontFamily: FONT }}>
			{lit && ring(9, { stroke: FIT_COLOR.medium, strokeWidth: 3, className: animated ? 'pc-lit' : undefined })}
			{open && ring(6, { stroke: INK, strokeWidth: 2 })}
			{square ? (
				<>
					<rect x={1.1} y={1.1} width={w - 2.2} height={h - 2.2} rx={8} fill="#fff" stroke={INK} strokeWidth={2.2} />
					<path d={`M${cx - 5} ${cy - 7} h10 v14 l-5 -4 l-5 4 z`} fill={INK} />
					{kind === 'kept' && (
						<g transform={`translate(${w - 1} 1)`}>
							<circle r={8.5} fill={INK} stroke="#fff" strokeWidth={2} />
							<path d="M-4 0 l3 3 l5 -6" stroke="#fff" strokeWidth={2} fill="none" />
						</g>
					)}
				</>
			) : (
				<circle cx={cx} cy={cy} r={r} fill={fit ? FIT_COLOR[fit] : UNSCORED} />
			)}
			{working &&
				ring(11, {
					stroke: INK2,
					strokeWidth: 2,
					strokeDasharray: '4 7',
					className: animated ? 'pc-working' : undefined,
				})}
			{status === 'contested' && (
				<g transform={`translate(${split.x} ${split.y})`}>
					<title>Split vote</title>
					<circle r={7} fill="#fff" stroke={WARN} strokeWidth={1.5} />
					<path d="M0 -7 A7 7 0 0 0 0 7 Z" fill={WARN} />
				</g>
			)}
			{status === 'new' && !open && (
				<g transform={`translate(${cx + r * 0.45} -12)`}>
					<rect width={34} height={16} rx={8} fill={INK} />
					<text x={17} y={11.6} textAnchor="middle" fontSize={9} fontWeight={700} fill="#fff" letterSpacing={0.6}>
						NEW
					</text>
				</g>
			)}
			<text x={cx} y={h + 17} fontSize={12} fontWeight={600} fill={INK} style={{ stroke: halo }} {...text}>
				{nodeLabel(authors, year)}
			</text>
			{sub && (
				<text x={cx} y={h + 31} fontSize={11} fill={INK2} style={{ stroke: halo }} {...text}>
					{sub}
				</text>
			)}
		</g>
	)
}
