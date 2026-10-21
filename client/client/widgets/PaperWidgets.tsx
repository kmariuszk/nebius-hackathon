import {
	Fragment,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type ReactNode,
} from 'react'
import { useValue, type Editor, type TLEventInfo, type TLShapeId } from 'tldraw'
import { NOTE_PIN_TYPE } from '../../shared/bindings.ts'
import { nodeLabel, shortAuthors } from '../../shared/display.ts'
import { paperShapeId } from '../../shared/ids.ts'
import type { PaperCardShape } from '../../shared/shapes.ts'
import { currentGoal, litPaperIds, openPaperId, paperMoreOpen } from '../viewerState.ts'
import { WidgetsContext, type LinkedPaper, type Toast, type WidgetsApi } from './context.ts'
import { emptyState } from './emptyStates.ts'
import { fadeCss, relatedSet, type Related } from './fade.ts'
import { noteAuthor, plainText } from './notes.ts'
import {
	ActionsWidget,
	EvidenceWidget,
	FigureWidget,
	GlanceWidget,
	LinkedWidget,
	NotesWidget,
	TitleWidget,
	WhyWidget,
	type NoteItem,
} from './parts.tsx'
import { COL, GAP, focusCamera, focusZoom, layoutWidgets, type Column, type Item, type Layout } from './placement.ts'
import './widgets.css'

// The v5 widgets around an opened paper (T10): siblings of <Tldraw> over `.Board-canvas`, so
// their pointer and keyboard events never reach the canvas. Everything here is this viewer's
// own view (decision D19); the only shared writes are votes and notes.

const ORDER = ['title', 'why', 'linked', 'glance', 'figure', 'actions', 'notes', 'evidence']
/** The open-paper ring the node draws around itself (PaperCardShapeUtil), in page units. */
const RING = 6

const close = () => {
	openPaperId.set(null)
	paperMoreOpen.set(false)
}

const isTyping = (target: EventTarget | null) =>
	target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

export function PaperWidgets({ editor, boardId, memberId }: { editor: Editor; boardId: string; memberId: string }) {
	const paperId = useValue(openPaperId)
	const [toast, setToast] = useState<Toast | null>(null)
	const endToast = useCallback(() => setToast(null), [])
	const shown = useRef<string | null>(null)
	const camera = useRef<{ x: number; y: number; z: number } | null>(null)

	// opening remembers the camera and closing flies back to it; another paper starts with More closed
	useEffect(() => {
		const was = shown.current
		if (paperId === was) return
		shown.current = paperId
		paperMoreOpen.set(false)
		if (paperId && !was) {
			const { x, y, z } = editor.getCamera()
			camera.current = { x, y, z }
		} else if (!paperId && camera.current) {
			editor.setCamera(camera.current, { animation: { duration: 450 } })
			camera.current = null
		}
	}, [editor, paperId])

	return (
		<div className="pw">
			{paperId && <OpenPaper key={paperId} editor={editor} boardId={boardId} memberId={memberId} paperId={paperId} onToast={setToast} />}
			{toast && <ToastView toast={toast} onDone={endToast} />}
		</div>
	)
}

interface OpenProps {
	editor: Editor
	boardId: string
	memberId: string
	onToast(toast: Toast): void
}

function OpenPaper({ paperId, ...props }: OpenProps & { paperId: string }) {
	const { editor } = props
	const shapeId = paperShapeId(paperId) as TLShapeId
	const shape = useValue(
		'open paper',
		() => {
			const s = editor.getShape(shapeId)
			return s?.type === 'paper-card' ? s : null
		},
		[editor, shapeId]
	)
	const hidden = useValue('open paper hidden', () => editor.isShapeHidden(shapeId), [editor, shapeId])

	// a paper that goes away (deleted, or discarded and hidden) closes; one not synced yet just waits
	const seen = useRef(false)
	useEffect(() => {
		if (shape && !hidden) seen.current = true
		else if (seen.current) close()
	}, [shape, hidden])

	if (!shape || hidden) return null
	return <Opened {...props} shape={shape} />
}

function Opened({ editor, boardId, memberId, onToast, shape }: OpenProps & { shape: PaperCardShape }) {
	const shapeId = shape.id
	const p = shape.props
	const goal = useValue(currentGoal)
	const more = useValue(paperMoreOpen)
	const canvasW = useValue('canvas width', () => editor.getViewportScreenBounds().w, [editor])
	const canvasH = useValue('canvas height', () => editor.getViewportScreenBounds().h, [editor])
	const related = useValue('related', () => gatherRelated(editor, shapeId), [editor, shapeId])
	const linked = useValue('linked papers', () => linkedPapers(editor, related, currentGoal.get()), [editor, related])
	const notes = useValue('pinned notes', () => pinnedNotes(editor, shapeId, memberId), [editor, shapeId, memberId])
	const [heights, measure] = useHeights()
	const [noteDraft, setNoteDraft] = useState(false)
	const [figureOpen, setFigureOpen] = useState(false)
	const [scroll, setScroll] = useState({ left: 0, right: 0 })

	// which widgets show (v5): the left column only what has data, is on its way or says why it never
	// came (emptyStates.ts); a seed's Why says it's a seed, over the suggestions linked to it
	const isSeed = p.kind === 'seed'
	const leftKeys = (['glance', 'figure'] as const).filter((k) => emptyState(p, k).kind !== 'hidden')
	const rightKeys = [
		'why',
		...(isSeed ? ['linked'] : []),
		...(notes.length || (more && !isSeed) || noteDraft ? ['notes'] : []),
		...(more && !isSeed ? ['evidence'] : []),
	]
	const keys = ['title', 'actions', ...leftKeys, ...rightKeys]

	const leftSig = leftKeys.join()
	const rightSig = rightKeys.join()
	const layout = useMemo(() => {
		const items = (sig: string): Item[] =>
			sig
				.split(',')
				.filter(Boolean)
				.map((key) => ({ key, h: heights[key] ?? 0, ...(key === 'evidence' ? { maxH: 420, minH: 160 } : {}) }))
		return layoutWidgets({
			width: canvasW,
			height: canvasH,
			title: heights.title ?? 0,
			actions: heights.actions ?? 0,
			left: items(leftSig),
			right: items(rightSig),
		})
	}, [heights, canvasW, canvasH, leftSig, rightSig])

	// shown once every widget has been measured; widgets that come later grow in on their own
	const [started, setStarted] = useState(false)
	const ready = keys.every((k) => (heights[k] ?? 0) > 0)
	useEffect(() => {
		if (ready) setStarted(true)
	}, [ready])
	const initial = useRef<Set<string> | null>(null)
	if (started && !initial.current) initial.current = new Set(keys)

	// the camera puts the node where the layout expects it, again when the canvas changes size
	const focused = useRef('')
	useEffect(() => {
		if (!started) return
		const key = `${canvasW}x${canvasH}`
		if (focused.current === key) return
		focused.current = key
		const b = editor.getShapePageBounds(shapeId)
		if (!b) return
		const around = related.papers.flatMap((id) => {
			const lb = editor.getShapePageBounds(id as TLShapeId)
			return lb ? [{ x: lb.center.x, y: lb.center.y, r: lb.w / 2 }] : []
		})
		const z = focusZoom(b.center, layout.home, around, { width: canvasW, height: canvasH })
		editor.setCamera(focusCamera(b.center, layout.home, z), { animation: { duration: 550 } })
	}, [started, canvasW, canvasH, layout, editor, shapeId, related])

	// peeking lights papers up on the board (litPaperIds) and fades the widgets
	const [peekState, setPeekState] = useState<{ key: string; paperIds: string[] } | null>(null)
	const litByUs = useRef<string[] | null>(null)
	const peek = useCallback((key: string | null, paperIds: string[] = []) => {
		if (key) {
			litPaperIds.set(paperIds)
			litByUs.current = paperIds
			setPeekState({ key, paperIds })
			return
		}
		// leave lights someone else turned on (a `_canvas/highlight`) alone
		if (litByUs.current && litPaperIds.get() === litByUs.current) litPaperIds.set([])
		litByUs.current = null
		setPeekState(null)
	}, [])
	useEffect(() => () => peek(null), [peek])

	const [popover, setPopover] = useState<{ rect: DOMRect; content: ReactNode } | null>(null)
	const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
	const showPop = useCallback(
		(el: HTMLElement, content: ReactNode, peekAt?: { key: string; paperIds: string[] }) => {
			clearTimeout(hideTimer.current)
			setPopover({ rect: el.getBoundingClientRect(), content })
			if (peekAt) peek(peekAt.key, peekAt.paperIds)
			else peek(null)
		},
		[peek]
	)
	const hidePop = useCallback(() => {
		clearTimeout(hideTimer.current)
		hideTimer.current = setTimeout(() => {
			setPopover(null)
			peek(null)
		}, 120)
	}, [peek])
	useEffect(() => () => clearTimeout(hideTimer.current), [])

	// Escape closes (the figure first), unless you're typing or tldraw needs it
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return
			if (figureOpen) return setFigureOpen(false)
			if (isTyping(e.target) || editor.getEditingShapeId() || editor.menus.hasAnyOpenMenus()) return
			close()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [editor, figureOpen])

	// a click (not a drag) on empty canvas closes
	useEffect(() => {
		let down: { x: number; y: number } | null = null
		const onEvent = (info: TLEventInfo) => {
			if (info.type !== 'pointer' || info.target !== 'canvas' || info.button !== 0) return
			if (info.name === 'pointer_down') {
				const hit = editor.getShapeAtPoint(editor.screenToPage(info.point), {
					hitInside: true,
					margin: 4 / editor.getZoomLevel(),
				})
				down = hit ? null : { x: info.point.x, y: info.point.y }
			} else if (info.name === 'pointer_up') {
				const tool = editor.getCurrentToolId()
				if (down && Math.hypot(info.point.x - down.x, info.point.y - down.y) < 5 && (tool === 'select' || tool === 'hand')) close()
				down = null
			}
		}
		editor.on('event', onEvent)
		return () => {
			editor.off('event', onEvent)
		}
	}, [editor])

	const api = useMemo<WidgetsApi>(() => {
		const pop = (k: string): CSSProperties | undefined => {
			const r = layout.rects[k]
			if (!started || !r) return undefined
			const order = initial.current?.has(k) ? ORDER.indexOf(k) : -1
			return {
				'--fx': `${layout.node.x - (r.x + r.w / 2)}px`,
				'--fy': `${layout.node.y - (r.y + r.h / 2)}px`,
				animationDelay: `${order < 0 ? 0 : 40 + order * 55}ms`,
			} as CSSProperties
		}
		return {
			editor,
			boardId,
			memberId,
			shape,
			goal,
			more,
			related,
			linked,
			measure,
			limits: layout.limits,
			pop,
			peekKey: peekState?.key ?? null,
			peek,
			showPop,
			hidePop,
			toast: onToast,
			openFigure: () => setFigureOpen(true),
			close,
			noteDraft,
			setNoteDraft,
		}
	}, [editor, boardId, memberId, shape, goal, more, related, linked, measure, layout, started, peekState, peek, showPop, hidePop, onToast, noteDraft])

	const relatedIds = useMemo(() => [...related.links.map((l) => l.id), ...related.papers, ...related.notes], [related])
	const css = fadeCss(shapeId, relatedIds, peekState ? [...relatedIds, ...peekState.paperIds.map(paperShapeId)] : [])

	const widget = (key: string) => {
		switch (key) {
			case 'why':
				return <WhyWidget />
			case 'linked':
				return <LinkedWidget />
			case 'glance':
				return <GlanceWidget />
			case 'figure':
				return <FigureWidget />
			case 'notes':
				return <NotesWidget notes={notes} />
			case 'evidence':
				return <EvidenceWidget />
		}
	}
	const slot = (key: string, child: ReactNode) => {
		const r = layout.rects[key]
		return (
			<div className="pw-slot" style={{ left: r.x, top: r.y, width: r.w }}>
				{child}
			</div>
		)
	}
	const column = (side: 'left' | 'right', col: Column | null) => {
		if (!col?.keys.length) return null
		const scrolls = col.maxH !== null
		return (
			<div
				className={`pw-col${scrolls ? ' scroll' : ''}`}
				style={{
					left: col.x - (scrolls ? 10 : 0),
					top: col.y,
					width: col.w + (scrolls ? 20 : 0),
					maxHeight: col.maxH ?? undefined,
				}}
				onScroll={(e) => {
					const top = e.currentTarget.scrollTop
					setScroll((s) => (s[side] === top ? s : { ...s, [side]: top }))
				}}
			>
				{col.keys.map((key) => (
					<Fragment key={key}>{widget(key)}</Fragment>
				))}
			</div>
		)
	}
	const scrolled = {
		left: layout.columns.left?.maxH != null ? scroll.left : 0,
		right: layout.columns.right.maxH != null ? scroll.right : 0,
	}

	return (
		<WidgetsContext.Provider value={api}>
			<style>{css}</style>
			<Anchored
				editor={editor}
				shapeId={shapeId}
				layout={layout}
				scroll={scrolled}
				className={`pw-group${started ? ' ready' : ''}${peekState ? ' peek' : ''}`}
				linesDelay={300 + (initial.current?.size ?? 0) * 55}
				onNoteTool={() => {
					setNoteDraft(true)
					onToast({ text: `Type your note. It’s pinned to ${nodeLabel(p.authors, p.year)}.` })
				}}
			>
				{slot('title', <TitleWidget />)}
				{slot('actions', <ActionsWidget onVoted={(decision) => decision === 'discard' && close()} />)}
				{column('left', layout.columns.left)}
				{column('right', layout.columns.right)}
			</Anchored>
			{popover && (
				<Popover rect={popover.rect} onEnter={() => clearTimeout(hideTimer.current)} onLeave={hidePop}>
					{popover.content}
				</Popover>
			)}
			{figureOpen && p.figure && (
				<div className="pw-lightbox" onClick={(e) => e.target === e.currentTarget && setFigureOpen(false)}>
					<div className="pw-lb">
						<button className="pw-x" onClick={() => setFigureOpen(false)} title="Close (Esc)">
							×
						</button>
						<img src={p.figure.imageUrl} alt={`${p.figure.label || 'Figure'} from the paper`} />
						<div className="pw-lbcap">
							<b>{p.figure.label || 'Figure'}</b> {p.figure.captionByAi && <span className="ai">AI</span>}
							{p.figure.caption}
							<div className="credit">
								From {[shortAuthors(p.authors), p.venue, p.year].filter(Boolean).join(' · ')}
								{p.url && (
									<>
										{' · '}
										<a href={p.url} target="_blank" rel="noreferrer">
											Open paper ↗
										</a>
									</>
								)}
							</div>
						</div>
					</div>
				</div>
			)}
		</WidgetsContext.Provider>
	)
}

interface AnchoredProps {
	editor: Editor
	shapeId: TLShapeId
	layout: Layout
	scroll: { left: number; right: number }
	className: string
	linesDelay: number
	onNoteTool(): void
	children: ReactNode
}

/** The group follows the node as the camera moves; only this and the connectors re-render then. */
function Anchored({ editor, shapeId, layout, scroll, className, linesDelay, onNoteTool, children }: AnchoredProps) {
	const anchor = useValue(
		'node on canvas',
		() => {
			const b = editor.getShapePageBounds(shapeId)
			if (!b) return null
			const at = editor.pageToViewport(b.center)
			return { x: at.x, y: at.y, z: editor.getZoomLevel(), half: b.w / 2 }
		},
		[editor, shapeId]
	)

	// pinch-zooming over a widget would zoom the whole page
	const ref = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const el = ref.current
		if (!el) return
		const onWheel = (e: WheelEvent) => {
			if (e.ctrlKey || e.metaKey) e.preventDefault()
		}
		el.addEventListener('wheel', onWheel, { passive: false })
		return () => el.removeEventListener('wheel', onWheel)
	}, [])

	if (!anchor) return null
	const k = layout.scale
	const nodeR = Math.min(((anchor.half + RING) * anchor.z + 3) / k, COL.center / 2 - GAP)
	return (
		<div
			ref={ref}
			className={className}
			style={{
				width: layout.width,
				transform: `translate(${anchor.x - layout.node.x * k}px, ${anchor.y - layout.node.y * k}px) scale(${k})`,
			}}
			// typing in a widget's input must not reach tldraw's shortcuts on the body
			onKeyDown={(e) => isTyping(e.target) && e.stopPropagation()}
			// "drop" a note on a widget: with the note tool, clicking a widget starts a pinned note
			onPointerDownCapture={(e) => {
				if (editor.getCurrentToolId() !== 'note' || !(e.target as HTMLElement).closest('.w')) return
				editor.setCurrentTool('select')
				onNoteTool()
			}}
		>
			<Connectors layout={layout} nodeR={nodeR} scroll={scroll} delay={linesDelay} />
			{children}
		</div>
	)
}

/** Thin grey lines from the node to each widget, as in v5: straight up and down in the middle, out along the gaps to the sides. */
function Connectors({ layout, nodeR, scroll, delay }: { layout: Layout; nodeR: number; scroll: { left: number; right: number }; delay: number }) {
	const o = layout.node
	const center = layout.columns.center
	const lines: ReactNode[] = []
	for (const key of ['title', 'actions']) {
		const r = layout.rects[key]
		const up = r.y + r.h <= o.y
		const ey = up ? r.y + r.h : r.y
		const sy = o.y + (up ? -nodeR : nodeR)
		if (up ? sy <= ey : sy >= ey) continue
		lines.push(
			<g key={key}>
				<path d={`M${o.x} ${sy} V${ey}`} />
				<circle className="end" cx={o.x} cy={ey} r={3.5} />
			</g>
		)
	}
	for (const side of ['left', 'right'] as const) {
		const col = layout.columns[side]
		if (!col) continue
		const left = side === 'left'
		const dir = left ? -1 : 1
		const chx = left ? center.x - GAP / 2 : center.x + center.w + GAP / 2
		const sx = o.x + dir * nodeR
		if (left ? sx <= chx : sx >= chx) continue
		for (const key of col.keys) {
			const r = layout.rects[key]
			const y = r.y - scroll[side]
			const ey = Math.max(y + 18, Math.min(y + r.h / 2, y + 64))
			if (ey < col.y || (col.maxH !== null && ey > col.y + col.maxH)) continue
			const ex = left ? r.x + r.w : r.x
			const dy = ey - o.y
			const v = Math.sign(dy)
			const cr = 10
			const d =
				Math.abs(dy) < 2 * cr
					? `M${sx} ${o.y} C${chx} ${o.y} ${chx} ${ey} ${ex} ${ey}`
					: `M${sx} ${o.y} H${chx - dir * cr} Q${chx} ${o.y} ${chx} ${o.y + v * cr} V${ey - v * cr} Q${chx} ${ey} ${chx + dir * cr} ${ey} H${ex}`
			lines.push(
				<g key={key}>
					<path d={d} />
					<circle className="end" cx={ex} cy={ey} r={3.5} />
				</g>
			)
		}
	}
	return (
		<svg className="pw-lines" width={1} height={1} style={{ animationDelay: `${delay}ms` }}>
			{lines}
		</svg>
	)
}

function Popover({ rect, onEnter, onLeave, children }: { rect: DOMRect; onEnter(): void; onLeave(): void; children: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null)
	const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
	useLayoutEffect(() => {
		const h = ref.current?.offsetHeight ?? 0
		const left = Math.max(12, Math.min(rect.left, window.innerWidth - 332))
		let top = rect.bottom + 8
		if (top + h > window.innerHeight - 12) top = Math.max(12, rect.top - h - 8)
		setPos({ left, top })
	}, [rect, children])
	return (
		<div
			ref={ref}
			className="pw-pop"
			style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
			onMouseEnter={onEnter}
			onMouseLeave={onLeave}
		>
			{children}
		</div>
	)
}

function ToastView({ toast, onDone }: { toast: Toast; onDone(): void }) {
	useEffect(() => {
		const t = setTimeout(onDone, 5000)
		return () => clearTimeout(t)
	}, [toast, onDone])
	return (
		<div className="pw-toast" role="status">
			<span>{toast.text}</span>
			{toast.undo && (
				<button
					onClick={() => {
						toast.undo!()
						onDone()
					}}
				>
					Undo
				</button>
			)}
		</div>
	)
}

/* ---------- reading the board ---------- */

function gatherRelated(editor: Editor, shapeId: TLShapeId): Related {
	const toCard = editor.getBindingsToShape(shapeId, 'arrow')
	const ends = toCard.flatMap((b) => editor.getBindingsFromShape(b.fromId, 'arrow'))
	const pins = editor.getBindingsToShape(shapeId, NOTE_PIN_TYPE)
	return relatedSet(shapeId, [...ends, ...pins], (id) => editor.getShape(id as TLShapeId), NOTE_PIN_TYPE)
}

function linkedPapers(editor: Editor, related: Related, goal: string): LinkedPaper[] {
	const seen = new Set<string>()
	return related.links.flatMap((l) => {
		const s = editor.getShape(l.other as TLShapeId)
		if (s?.type !== 'paper-card' || seen.has(s.id)) return []
		seen.add(s.id)
		const q = s.props
		const relation = l.label || (l.kind === 'cites' ? (l.dir === 'in' ? 'cites it' : 'cited by it') : l.kind === 'similar' ? 'similar' : 'linked')
		return [
			{
				shapeId: s.id,
				paperId: q.paperId,
				kind: q.kind,
				label: nodeLabel(q.authors, q.year),
				fit: q.scores[goal]?.fit ?? null,
				relation,
				cites: l.kind === 'cites' ? l.dir : null,
			},
		]
	})
}

function pinnedNotes(editor: Editor, shapeId: TLShapeId, memberId: string): NoteItem[] {
	return editor.getBindingsToShape(shapeId, NOTE_PIN_TYPE).flatMap((b) => {
		const note = editor.getShape(b.fromId)
		if (note?.type !== 'note') return []
		return [{ id: note.id, text: plainText(note.props.richText), author: noteAuthor(note.meta, memberId) }]
	})
}

/** Natural heights of the widgets (their inner wrapper, unscaled), kept current as content arrives. */
function useHeights() {
	const [heights, setHeights] = useState<Record<string, number>>({})
	const els = useRef(new Map<string, HTMLElement>())
	const observer = useRef<ResizeObserver | null>(null)
	useEffect(() => {
		const ro = new ResizeObserver((entries) => {
			setHeights((prev) => {
				let next = prev
				for (const entry of entries) {
					const el = entry.target as HTMLElement
					const key = el.dataset.measure
					if (!key || els.current.get(key) !== el) continue
					if (prev[key] !== el.offsetHeight) {
						if (next === prev) next = { ...prev }
						next[key] = el.offsetHeight
					}
				}
				return next
			})
		})
		observer.current = ro
		els.current.forEach((el) => ro.observe(el))
		return () => {
			ro.disconnect()
			observer.current = null
		}
	}, [])
	const refs = useRef(new Map<string, (el: HTMLElement | null) => void>())
	const measure = useCallback((key: string) => {
		let ref = refs.current.get(key)
		if (!ref) {
			ref = (el: HTMLElement | null) => {
				const prev = els.current.get(key)
				if (prev && prev !== el) observer.current?.unobserve(prev)
				if (el) {
					el.dataset.measure = key
					els.current.set(key, el)
					observer.current?.observe(el)
				} else {
					els.current.delete(key)
					setHeights((h) => {
						if (!(key in h)) return h
						const next = { ...h }
						delete next[key]
						return next
					})
				}
			}
			refs.current.set(key, ref)
		}
		return ref
	}, [])
	return [heights, measure] as const
}
