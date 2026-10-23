import {
	createShapeId,
	react,
	startEditingShapeWithRichText,
	unsafe__withoutCapture,
	type Editor,
	type TLBinding,
	type TLShape,
	type TLShapeId,
} from 'tldraw'
import { NOTE_PIN_TYPE } from '../../shared/bindings.ts'
import { cardLabel } from '../../shared/display.ts'
import { isPaperCard } from '../../shared/paperCard.ts'
import { CARD_SIZE, type PaperCardShape } from '../../shared/shapes.ts'
import { boardOf, changes, recordEdit } from '../pinboard/changes.ts'
import { NOTE_SCALE, pinOffset, plainText } from '../widgets/notes.ts'
import { toast } from './toast.ts'

// Pinning notes on the canvas (T14): a note a person puts down with its centre on a paper's card
// is pinned to that paper with a `note-pin` binding (T01), beside the card as v6 pins them, and
// moves with it; one dragged well away from its paper comes loose. The geometry is pure, so it
// runs under `node --test`; registerPinNotes wires it to the editor.

interface Pt {
	x: number
	y: number
}

export interface Box {
	x: number
	y: number
	w: number
	h: number
}

/** A paper card in page space: its shape ID and the 172 × 70 card it draws (getShapePageBounds). */
export interface CardBox {
	id: string
	box: Box
}

const inside = (p: Pt, b: Box) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h
const centre = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })

/** The card whose drawn box holds the point; of overlapping cards, the one whose centre is nearest. */
export function cardUnder<C extends CardBox>(p: Pt, cards: readonly C[]): C | null {
	let best: C | null = null
	let bestD = Infinity
	for (const card of cards) {
		if (!inside(p, card.box)) continue
		const c = centre(card.box)
		const d = Math.hypot(c.x - p.x, c.y - p.y)
		if (d < bestD) {
			best = card
			bestD = d
		}
	}
	return best
}

/** The gap between two boxes; 0 when they touch or overlap. */
export function gap(a: Box, b: Box): number {
	const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w))
	const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h))
	return Math.hypot(dx, dy)
}

/** A pinned note comes loose once it's more than a card's width from its paper. */
export const UNPIN_GAP = CARD_SIZE.w

export type NotePlace = { pin: string } | { unpin: true } | null

/**
 * What putting a note down does: pin it to the card under its centre (or re-place it beside its
 * own card), unpin it when it's dragged too far from its paper, or nothing.
 */
export function placeNote(note: Box, pinnedTo: string | null, cards: readonly CardBox[]): NotePlace {
	const target = cardUnder(centre(note), cards)
	if (target) return { pin: target.id }
	const own = pinnedTo ? cards.find((c) => c.id === pinnedTo) : undefined
	if (own && gap(note, own.box) > UNPIN_GAP) return { unpin: true }
	return null
}

// ---- the editor

/** How the note came to be put down: made with the Note tool, dropped from the toolbar, made some other way, or dragged. */
type Why = 'tool' | 'dropped' | 'created' | 'moved'

const queues = new WeakMap<Editor, Map<TLShapeId, Why>>()

/** Notes a person creates or drags are settled once they're put down. Returns the cleanup. */
export function registerPinNotes(editor: Editor): () => void {
	const queue = new Map<TLShapeId, Why>()
	let busy = false
	// a note is put down once the Note tool's press and any drag are over
	const moving = () => editor.isIn('note.pointing') || editor.isIn('select.translating')
	const flush = () => {
		if (busy || !queue.size || moving()) return
		const notes = [...queue]
		queue.clear()
		busy = true
		try {
			for (const [id, why] of notes) settle(editor, id, why)
		} finally {
			busy = false
		}
	}
	queues.set(editor, queue)

	// the toolbar's Note, dragged onto the board: caught before tldraw's own drop handling
	const container = editor.getContainer()
	const isNote = (e: DragEvent) => !!e.dataTransfer?.types.includes(NOTE_DRAG_TYPE)
	const over = (e: DragEvent) => {
		if (!isNote(e)) return
		e.preventDefault()
		e.dataTransfer!.dropEffect = 'copy'
	}
	const drop = (e: DragEvent) => {
		if (!isNote(e)) return
		e.preventDefault()
		e.stopPropagation()
		editor.markEventAsHandled(e)
		dropNoteAt(editor, editor.screenToPage({ x: e.clientX, y: e.clientY }))
	}
	container.addEventListener('dragover', over, true)
	container.addEventListener('drop', drop, true)

	const cleanups = [
		() => {
			container.removeEventListener('dragover', over, true)
			container.removeEventListener('drop', drop, true)
		},
		editor.sideEffects.registerAfterCreateHandler('shape', (shape, source) => {
			if (busy || source !== 'user' || shape.type !== 'note' || queue.has(shape.id)) return
			queue.set(shape.id, editor.isIn('note') ? 'tool' : 'created')
		}),
		editor.sideEffects.registerAfterChangeHandler('shape', (prev, next, source) => {
			if (busy || source !== 'user' || next.type !== 'note') return
			if (prev.x === next.x && prev.y === next.y && prev.parentId === next.parentId) return
			// notes that move along with their paper aren't put down by anyone
			if (!editor.getSelectedShapeIds().includes(next.id)) return
			if (!queue.has(next.id)) queue.set(next.id, 'moved')
		}),
		editor.sideEffects.registerOperationCompleteHandler(flush),
		react('pin notes once they are put down', () => {
			if (!moving()) unsafe__withoutCapture(flush)
		}),
	]
	return () => {
		cleanups.forEach((cleanup) => cleanup())
		if (queues.get(editor) === queue) queues.delete(editor)
	}
}

function settle(editor: Editor, id: TLShapeId, why: Why) {
	const note = editor.getShape(id)
	const bounds = note ? editor.getShapePageBounds(note) : undefined
	if (note?.type !== 'note' || !bounds) return
	const pin = editor.getBindingsFromShape(note, NOTE_PIN_TYPE)[0]
	const cards = new Map<string, PaperCardShape>()
	const boxes: CardBox[] = []
	for (const s of editor.getCurrentPageShapes()) {
		const box = isPaperCard(s) && !editor.isShapeHidden(s) ? editor.getShapePageBounds(s) : undefined
		if (!isPaperCard(s) || !box) continue
		cards.set(s.id, s)
		boxes.push({ id: s.id, box })
	}
	const place = placeNote(bounds, pin?.toId ?? null, boxes)
	let pinnedTo = pin ? editor.getShape(pin.toId) : undefined
	if (place && 'pin' in place) {
		const card = cards.get(place.pin)!
		pinTo(editor, note, card, pin)
		if (pin?.toId !== card.id) toast(`Note pinned to ${cardLabel(card)}. It moves with the paper.`)
		pinnedTo = card
	} else if (place && pin) {
		editor.deleteBinding(pin.id)
		toast('Note unpinned.')
		pinnedTo = undefined
	} else if (!pin && (why === 'tool' || why === 'dropped')) {
		toast('Note added. Drop it on a paper to pin it there.')
	}

	// for Update suggestions (T13): a new note, or an old one pinned or unpinned
	const text = plainText(note.props.richText)
	const paperId = isPaperCard(pinnedTo) ? pinnedTo.props.paperId : null
	if (why !== 'moved') recordEdit(editor, { type: 'note_added', noteId: note.id, text, ...(paperId ? { paperId } : {}) })
	else if (paperId && pinnedTo?.id !== pin?.toId) recordEdit(editor, { type: 'note_pinned', noteId: note.id, text, paperId })
	else if (!paperId && pin) {
		const boardId = boardOf(editor)
		const was = editor.getShape(pin.toId)
		if (boardId && isPaperCard(was)) changes.noteUnpinned(boardId, note.id, text, was.props.paperId)
	}
}

/** Moves the note beside the card and pins it there; a pin to another paper goes. */
function pinTo(editor: Editor, note: TLShape, card: PaperCardShape, pin: TLBinding | undefined) {
	const at = editor.getShapePageTransform(card).point()
	const others = editor.getBindingsToShape(card.id, NOTE_PIN_TYPE).filter((b) => b.fromId !== note.id).length
	const { dx, dy } = pinOffset(card.props, others)
	editor.run(() => {
		if (pin && pin.toId !== card.id) editor.deleteBinding(pin.id)
		const p = editor.getPointInParentSpace(note, { x: at.x + dx, y: at.y + dy })
		editor.updateShape({ id: note.id, type: note.type, x: p.x, y: p.y })
		if (pin?.toId === card.id) editor.updateBinding({ id: pin.id, type: NOTE_PIN_TYPE, props: { dx, dy } })
		else editor.createBinding({ type: NOTE_PIN_TYPE, fromId: note.id, toId: card.id, props: { dx, dy } })
	})
}

/** What the toolbar's Note carries when it's dragged (an HTML drag). */
export const NOTE_DRAG_TYPE = 'application/x-pinboard-note'

/** The board's notes are 200 px at scale 1; the toolbar's are the widgets' size. */
const DROPPED_NOTE = 200 * NOTE_SCALE

/** The toolbar's Note dropped on the board at a page point: a note there, pinned if it's on a paper, ready to type in. */
export function dropNoteAt(editor: Editor, point: Pt) {
	const id = createShapeId()
	editor.markHistoryStoppingPoint('drop a note')
	editor.setCurrentTool('select')
	queues.get(editor)?.set(id, 'dropped')
	editor.createShape({
		id,
		type: 'note',
		x: point.x - DROPPED_NOTE / 2,
		y: point.y - DROPPED_NOTE / 2,
		props: { scale: NOTE_SCALE, size: 's', font: 'sans', align: 'start', verticalAlign: 'start' },
	})
	editor.select(id)
	startEditingShapeWithRichText(editor, id)
}
