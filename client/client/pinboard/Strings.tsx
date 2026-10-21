import { useRef, type MouseEvent } from 'react'
import { useEditor, useValue, type Editor, type TLShape, type TLShapeId } from 'tldraw'
import { isPaperCard } from '../../shared/paperCard'
import type { PaperCardShape } from '../../shared/shapes'
import { kindOf, linkTag } from '../editing/linkRules'
import { hoveredLink, linkEditorAt, openLinkEditor } from '../editing/linkState'
import { isSaved } from '../shapes/card'
import { openPaperId } from '../viewerState'

// v6 strings (docs/mockups/flashcard-v6.html): the links between papers are drawn here, under the
// cards, running pin to pin with a little sag. The built-in arrows that hold the links stay in the
// room for the server and the widgets; getShapeVisibility hides them on screen. Each string has a
// wide invisible stroke on top that you can point at (its pill shows) and click (the link editor
// opens, T14); the rest of the layer ignores the pointer.

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

interface Pt {
	x: number
	y: number
}
interface Line {
	id: TLShapeId
	d: string
	mid: Pt
	cls: string
	knots: Pt[]
	tag: string | null
	mine: boolean
	faded: boolean
	/** Links between your own papers are only drawn when you point at or open one; they can still be pointed at. */
	drawn: boolean
}

/** The two paper cards an arrow links, or null when it isn't a link between papers. */
export function linkedCards(editor: Editor, arrow: TLShape): [PaperCardShape, PaperCardShape] | null {
	const bindings = editor.getBindingsFromShape(arrow, 'arrow')
	if (bindings.length !== 2) return null
	const start = bindings.find((b) => b.props.terminal === 'start')
	const end = bindings.find((b) => b.props.terminal === 'end')
	const a = start && editor.getShape(start.toId)
	const b = end && editor.getShape(end.toId)
	return isPaperCard(a) && isPaperCard(b) ? [a, b] : null
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
	const nh = !open && isPaperCard(hovered) ? hovered.props.paperId : null
	// the string you point at (not through a card) and the one being edited
	const pointed = !hovered && editor.isIn('select.idle') ? hoveredLink.get() : null
	const editing = linkEditorAt.get()?.arrowId ?? null
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
		const kind = kindOf(arrow.meta)
		const label = typeof arrow.meta.label === 'string' ? arrow.meta.label : ''
		const inc = (id: string | null) => !!id && (a.props.paperId === id || b.props.paperId === id)
		const lit = arrow.id === pointed || arrow.id === editing
		const on = inc(open) || inc(nh) || lit
		const mine = kind === 'user' || !!label
		const faded = !lit && ((!!open && !on) || (!!nh && !inc(nh)))
		const p = sag(A, B)
		const knots = [a, b].filter((c) => !isSaved(c) && c.props.paperId !== open).map((c) => (c === a ? A : B))
		const tag = mine || on ? linkTag(kind, label) : null
		lines.push({
			id: arrow.id,
			d: p.d,
			mid: p.mid,
			cls: `${kind}${on ? ' on' : ''}${faded ? ' faded' : ''}${!on && !faded ? ' rest' : ''}`,
			knots,
			tag,
			mine,
			faded,
			drawn: on || mine || !isSaved(a) || !isSaved(b),
		})
	}
	return lines
}

// a string takes the pointer only from the select tool, and not where a card or a note lies on it
function pointable(editor: Editor, e: MouseEvent) {
	if (e.button !== 0 || !editor.isIn('select.idle')) return false
	const at = editor.screenToPage({ x: e.clientX, y: e.clientY })
	return !editor.getShapeAtPoint(at, { hitInside: true, filter: (s) => s.type !== 'arrow' && s.type !== 'frame' })
}

export function Strings() {
	const editor = useEditor()
	const all = useValue('pinboard strings', () => computeLines(editor), [editor])
	const lines = all.filter((l) => l.drawn)
	const pressed = useRef<TLShapeId | null>(null)
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
			{all.map((l) => (
				<path
					key={`h${l.id}`}
					className="pb-hit"
					d={l.d}
					onPointerEnter={() => hoveredLink.set(l.id)}
					onPointerLeave={() => hoveredLink.get() === l.id && hoveredLink.set(null)}
					// the canvas never sees the press, so it doesn't start a selection box
					onPointerDown={(e) => {
						pressed.current = pointable(editor, e) ? l.id : null
						if (pressed.current) editor.markEventAsHandled(e)
					}}
					onPointerUp={(e) => pressed.current === l.id && editor.markEventAsHandled(e)}
					onClick={(e) => {
						if (pressed.current !== l.id) return
						pressed.current = null
						const screen = editor.getViewportScreenBounds()
						openLinkEditor(l.id, { x: e.clientX - screen.x, y: e.clientY - screen.y })
					}}
				>
					<title>Click to name, hide or delete this link</title>
				</path>
			))}
		</svg>
	)
}
