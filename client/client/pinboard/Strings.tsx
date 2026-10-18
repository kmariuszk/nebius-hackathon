import { useEditor, useValue, type Editor, type TLShape } from 'tldraw'
import type { PaperCardShape } from '../../shared/shapes'
import { isSaved } from '../shapes/card'
import { openPaperId } from '../viewerState'

// v6 strings (docs/mockups/flashcard-v6.html): the links between papers are drawn here, under the
// cards, running pin to pin with a little sag. The built-in arrows that hold the links stay in the
// room for the server and the widgets; getShapeVisibility hides them on screen.

/** Pin, blur and tape filters for the cards and strings, inside tldraw's own <defs>. */
export function PinboardDefs() {
	return (
		<>
			<radialGradient id="pbPin" cx=".5" cy=".5" r=".6" fx=".36" fy=".32">
				<stop offset="0" stopColor="#ffb3ae" />
				<stop offset=".45" stopColor="#e0453f" />
				<stop offset="1" stopColor="#9e2420" />
			</radialGradient>
			<filter id="pbBlur" x="-10%" y="-40%" width="120%" height="180%">
				<feGaussianBlur stdDeviation="1.2" />
			</filter>
			<filter id="pbTape" x="-5%" y="-20%" width="110%" height="150%">
				<feDropShadow dx="0" dy="1" stdDeviation=".6" floodColor="#2a1a0c" floodOpacity=".18" />
			</filter>
		</>
	)
}

type Kind = 'cites' | 'similar' | 'user'
interface Pt {
	x: number
	y: number
}
interface Line {
	id: string
	d: string
	mid: Pt
	cls: string
	knots: Pt[]
	tag: string | null
	mine: boolean
	faded: boolean
}

const isCard = (s: TLShape | undefined): s is PaperCardShape => s?.type === 'paper-card'

/** The two paper cards an arrow links, or null when it isn't a link between papers. */
export function linkedCards(editor: Editor, arrow: TLShape): [PaperCardShape, PaperCardShape] | null {
	const bindings = editor.getBindingsFromShape(arrow, 'arrow')
	if (bindings.length !== 2) return null
	const start = bindings.find((b) => b.props.terminal === 'start')
	const end = bindings.find((b) => b.props.terminal === 'end')
	const a = start && editor.getShape(start.toId)
	const b = end && editor.getShape(end.toId)
	return isCard(a) && isCard(b) ? [a, b] : null
}

function pinOf(editor: Editor, card: PaperCardShape): Pt | null {
	const b = editor.getShapePageBounds(card)
	return b ? { x: b.center.x, y: b.minY + 1 } : null
}

// string sags a little between two pins
function sag(A: Pt, B: Pt) {
	const dx = B.x - A.x
	const dy = B.y - A.y
	const s = 6 + Math.abs(dx) * 0.08 + Math.abs(dy) * 0.02
	const C = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 + s }
	return {
		d: `M${A.x.toFixed(1)} ${A.y.toFixed(1)} Q${C.x.toFixed(1)} ${C.y.toFixed(1)} ${B.x.toFixed(1)} ${B.y.toFixed(1)}`,
		mid: { x: 0.25 * A.x + 0.5 * C.x + 0.25 * B.x, y: 0.25 * A.y + 0.5 * C.y + 0.25 * B.y },
	}
}

function computeLines(editor: Editor): Line[] {
	const open = openPaperId.get()
	const hoveredId = editor.getHoveredShapeId()
	const hovered = hoveredId ? editor.getShape(hoveredId) : undefined
	const nh = !open && isCard(hovered) ? hovered.props.paperId : null
	const lines: Line[] = []
	for (const arrow of editor.getCurrentPageShapes()) {
		if (arrow.type !== 'arrow' || arrow.meta.hiddenByHuman === true) continue
		const pair = linkedCards(editor, arrow)
		if (!pair) continue
		const [a, b] = pair
		if (editor.isShapeHidden(a) || editor.isShapeHidden(b)) continue
		const A = pinOf(editor, a)
		const B = pinOf(editor, b)
		if (!A || !B) continue
		const meta = arrow.meta as { kind?: string; label?: string }
		const kind: Kind = meta.kind === 'cites' || meta.kind === 'similar' ? meta.kind : 'user'
		const label = typeof meta.label === 'string' ? meta.label : ''
		const inc = (id: string | null) => !!id && (a.props.paperId === id || b.props.paperId === id)
		const on = inc(open) || inc(nh)
		const mine = kind === 'user' || !!label
		// links between your own papers show only when you point at or open one
		if (!on && !mine && isSaved(a) && isSaved(b)) continue
		const faded = (!!open && !on) || (!!nh && !inc(nh))
		const p = sag(A, B)
		const knots = [a, b].filter((c) => !isSaved(c) && c.props.paperId !== open).map((c) => (c === a ? A : B))
		const tag = mine || on ? (label ? (kind === 'cites' ? `${label} · cites` : label) : kind === 'user' ? 'linked' : kind) : null
		lines.push({
			id: arrow.id,
			d: p.d,
			mid: p.mid,
			cls: `${kind}${on ? ' on' : ''}${faded ? ' faded' : ''}${!on && !faded ? ' rest' : ''}`,
			knots,
			tag,
			mine,
			faded,
		})
	}
	return lines
}

export function Strings() {
	const editor = useEditor()
	const lines = useValue('pinboard strings', () => computeLines(editor), [editor])
	return (
		<svg className="pb-strings" aria-hidden="true">
			{lines.map((l) => (
				<path key={`s${l.id}`} className={`pb-shadow ${l.cls}`} d={l.d} transform="translate(1 3)" />
			))}
			{lines.map((l) => (
				<path key={`l${l.id}`} className={`pb-string ${l.cls}`} d={l.d} />
			))}
			{lines.flatMap((l) =>
				l.knots.map((q, i) => (
					<circle key={`k${l.id}${i}`} className="pb-knot" cx={q.x} cy={q.y} r={2.6} opacity={l.faded ? 0.15 : 1} />
				))
			)}
			{lines.map((l, i) => {
				if (!l.tag) return null
				const w = l.tag.length * 6.4 + 16
				return (
					<g
						key={`t${l.id}`}
						className={`pb-tag${l.mine ? ' mine' : ''}${l.faded ? ' faded' : ''}`}
						transform={`translate(${l.mid.x.toFixed(1)} ${l.mid.y.toFixed(1)}) rotate(${((i % 5) - 2) * 1.2})`}
					>
						<rect x={-w / 2} y={-10} width={w} height={20} rx={2} filter="url(#pbTape)" />
						<text y={4}>{l.tag}</text>
					</g>
				)
			})}
		</svg>
	)
}
