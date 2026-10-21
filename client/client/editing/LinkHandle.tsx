import { useState, type PointerEvent } from 'react'
import { createShapeId, useEditor, useValue, type Editor, type TLShapeId } from 'tldraw'
import { linkShapeId } from '../../shared/ids'
import { isPaperCard } from '../../shared/paperCard'
import type { PaperCardShape } from '../../shared/shapes'
import { recordEdit } from '../pinboard/changes'
import { linkedCards } from '../pinboard/Strings'
import { openPaperId } from '../viewerState'
import { openLinkEditor } from './linkState'
import { toast } from './toast'

// The + handle (T14, v6 demo board): on the right edge of the card you point at; drag it onto
// another paper to link them, and the link editor opens to name the link. In front of the canvas
// (components.InFrontOfTheCanvas), so tldraw leaves its pointer events alone.

interface Drag {
	from: TLShapeId
	x: number
	y: number
	moved: boolean
}

export function LinkHandle() {
	const editor = useEditor()
	const [drag, setDrag] = useState<Drag | null>(null)
	const hovered = useValue(
		'link handle card',
		() => {
			if (!editor.isIn('select.idle')) return null
			const id = editor.getHoveredShapeId()
			const shape = id ? editor.getShape(id) : undefined
			// the open paper has its widgets around it instead
			return isPaperCard(shape) && openPaperId.get() !== shape.props.paperId ? shape.id : null
		},
		[editor]
	)
	const from = drag?.from ?? hovered
	const at = useValue(
		'link handle place',
		() => {
			const b = from ? editor.getShapePageBounds(from) : undefined
			return b ? editor.pageToViewport({ x: b.maxX, y: b.midY }) : null
		},
		[editor, from]
	)
	if (!from || !at) return null
	const x = at.x + 12
	const y = at.y

	const point = (e: PointerEvent) => {
		const screen = editor.getViewportScreenBounds()
		return { x: e.clientX - screen.x, y: e.clientY - screen.y }
	}
	return (
		<>
			{drag?.moved && (
				<svg className="pb-rubber" aria-hidden="true">
					<line x1={x} y1={y} x2={drag.x} y2={drag.y} />
				</svg>
			)}
			<div
				className="pb-handle"
				style={{ left: x, top: y }}
				title="Drag onto another paper to link them"
				onPointerDown={(e) => {
					if (e.button !== 0) return
					e.currentTarget.setPointerCapture(e.pointerId)
					setDrag({ from, ...point(e), moved: false })
				}}
				// over the handle the card stays the one pointed at
				onPointerMove={(e) => {
					editor.markEventAsHandled(e)
					if (!drag) return
					const p = point(e)
					setDrag({ ...drag, ...p, moved: drag.moved || Math.hypot(p.x - x, p.y - y) > 6 })
				}}
				onPointerUp={(e) => {
					if (!drag) return
					setDrag(null)
					if (drag.moved) dropLink(editor, drag.from, e.clientX, e.clientY, point(e))
				}}
				onPointerCancel={() => setDrag(null)}
			>
				<svg width="20" height="20" viewBox="-10 -10 20 20" aria-hidden="true">
					<circle r={9} />
					<path d="M-4 0h8M0 -4v8" />
				</svg>
			</div>
		</>
	)
}

function dropLink(editor: Editor, fromId: TLShapeId, clientX: number, clientY: number, at: { x: number; y: number }) {
	const from = editor.getShape(fromId)
	const target = editor.getShapeAtPoint(editor.screenToPage({ x: clientX, y: clientY }), {
		hitInside: true,
		margin: editor.getHitTestMargin(),
		filter: (s) => s.type === 'paper-card' && s.id !== fromId && !editor.isShapeHidden(s),
	})
	if (!isPaperCard(from) || !isPaperCard(target)) {
		toast('Drop the link on another paper.')
		return
	}
	const { id, existed } = linkCards(editor, from, target)
	if (existed) toast('These papers are already linked. You can name that link.')
	else recordEdit(editor, { type: 'link_added', from: from.props.paperId, to: target.props.paperId, kind: 'user' })
	openLinkEditor(id, at)
}

/** The link joining two papers (either way, any kind, not hidden), or a new one of yours. */
export function linkCards(editor: Editor, a: PaperCardShape, b: PaperCardShape): { id: TLShapeId; existed: boolean } {
	for (const binding of editor.getBindingsToShape(a.id, 'arrow')) {
		const arrow = editor.getShape(binding.fromId)
		const pair = arrow && arrow.meta.hiddenByHuman !== true ? linkedCards(editor, arrow) : null
		if (arrow && pair?.some((card) => card.id === b.id)) return { id: arrow.id, existed: true }
	}
	const A = editor.getShapePageBounds(a)!.center
	const B = editor.getShapePageBounds(b)!.center
	// one link per pair and kind, as the canvas MCP names them; a hidden one of yours keeps its own
	const named = linkShapeId(a.props.paperId, b.props.paperId, 'user') as TLShapeId
	const id = editor.getShape(named) ? createShapeId() : named
	editor.markHistoryStoppingPoint('link two papers')
	editor.run(() => {
		// meta: sideEffects.ts makes it kind "user", by this member (guards.ts userLinkMeta)
		editor.createShape({ id, type: 'arrow', x: A.x, y: A.y, props: { start: { x: 0, y: 0 }, end: { x: B.x - A.x, y: B.y - A.y } } })
		editor.createBindings(
			(['start', 'end'] as const).map((terminal) => ({
				type: 'arrow' as const,
				fromId: id,
				toId: terminal === 'start' ? a.id : b.id,
				props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' as const },
			}))
		)
	})
	return { id, existed: false }
}
