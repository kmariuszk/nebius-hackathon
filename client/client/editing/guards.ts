import type { Editor, TLBinding, TLShapeId } from 'tldraw'

// What people may not delete on the board (T14): papers leave by Discard, so the agent and the
// team see the decision; citations are a PubMed fact, so they can be hidden but not deleted.
// The rules are pure; registerGuards wires them to the editor.

interface ShapeLike {
	type: string
	meta: Record<string, unknown>
}

export const PAPER_REFUSED = 'Use Discard to take a paper off the board.'
export const CITES_REFUSED = 'Citations can be hidden, not deleted.'

/** Why a person may not delete this shape, or null if they may. */
export function deleteRefusal(shape: ShapeLike): string | null {
	if (shape.type === 'paper-card') return PAPER_REFUSED
	if (shape.type === 'arrow' && shape.meta.kind === 'cites') return CITES_REFUSED
	return null
}

/**
 * Every link has a kind: an arrow a person makes (with the + handle, or tldraw's own arrow
 * shortcut) is theirs, kind "user" with an empty label. Returns `meta` itself when it already has one.
 */
export function userLinkMeta<M extends Record<string, unknown>>(meta: M, memberId: string): M {
	if (typeof meta.kind === 'string') return meta
	return { ...meta, kind: 'user', label: '', by: memberId, hiddenByHuman: false }
}

/**
 * While a delete with refused shapes runs, a binding stays when it touches a refused shape and
 * neither of its ends is really going: a paper's links and pinned notes stay, a deleted note's
 * pin goes with the note.
 */
export function keepsBinding(
	binding: { fromId: string; toId: string },
	refused: ReadonlySet<string>,
	gone: ReadonlySet<string>
): boolean {
	const { fromId, toId } = binding
	return (refused.has(fromId) || refused.has(toId)) && !gone.has(fromId) && !gone.has(toId)
}

let reparenting = false

/** True from the guard moving a deleted cluster's papers onto the page until that operation completes: nobody moved them. */
export const isGuardReparent = () => reparenting

/**
 * Refuses a person's Delete (or Cut, or eraser) on papers and citations, with a toast. tldraw
 * removes a shape's bindings before asking the delete handlers, so while a refused delete runs
 * the bindings and the arrows bound to it are kept as they were too. Returns the cleanup.
 */
export function registerGuards(editor: Editor, toast: (text: string) => void): () => void {
	// while a delete with refused shapes runs: those shapes, and the ones it does remove
	let refused = new Set<TLShapeId>()
	let gone = new Set<TLShapeId>()
	const kept = (b: TLBinding) => keepsBinding(b, refused, gone)

	// tldraw names what a person deletes just before it removes them
	const onDeleting = (ids: TLShapeId[]) => {
		const deleting = new Set(ids)
		const keep = ids.filter((id) => {
			const shape = editor.getShape(id)
			return shape ? deleteRefusal(shape) !== null : false
		})
		if (!keep.length) return
		// a paper inside a deleted cluster stays on the board where it is
		const inDeleted = keep.filter((id) => editor.findShapeAncestor(id, (a) => deleting.has(a.id)))
		// and a note pinned to a paper that stays goes with the paper, not the frame
		const staying = new Set(inDeleted)
		const pinnedNotes = ids.filter((id) => {
			const shape = editor.getShape(id)
			return (
				shape?.type === 'note' &&
				editor.findShapeAncestor(id, (a) => deleting.has(a.id)) &&
				editor.getBindingsFromShape(id, 'note-pin').some((b) => staying.has(b.toId))
			)
		})
		const toReparent = [...inDeleted, ...pinnedNotes]
		if (toReparent.length) {
			reparenting = true
			editor.reparentShapes(toReparent, editor.getCurrentPageId())
		}
		// set after the reparenting, whose own operation would clear them
		refused = new Set([...keep, ...pinnedNotes])
		gone = new Set(ids.filter((id) => !refused.has(id)))
		const asked = keep.filter((id) => !inDeleted.includes(id)).map((id) => deleteRefusal(editor.getShape(id)!)!)
		if (asked.length) toast(asked.includes(PAPER_REFUSED) ? PAPER_REFUSED : CITES_REFUSED)
	}
	editor.on('deleted-shapes', onDeleting)

	const cleanups = [
		editor.sideEffects.registerBeforeDeleteHandler('shape', (shape, source) => {
			if (source === 'user' && refused.has(shape.id)) return false
		}),
		// a binding between two shapes that both stay, a paper's links and pinned notes among them
		editor.sideEffects.registerBeforeDeleteHandler('binding', (binding, source) => {
			if (source === 'user' && refused.size && kept(binding)) return false
		}),
		// and an arrow that stays keeps its ends where they were
		editor.sideEffects.registerBeforeChangeHandler('shape', (prev, next, source) =>
			source === 'user' &&
			refused.size &&
			next.type === 'arrow' &&
			!gone.has(next.id) &&
			editor.getBindingsFromShape(next.id, 'arrow').some(kept)
				? prev
				: next
		),
		editor.sideEffects.registerOperationCompleteHandler(() => {
			reparenting = false
			if (!refused.size) return
			refused = new Set()
			gone = new Set()
		}),
	]
	return () => {
		editor.off('deleted-shapes', onDeleting)
		cleanups.forEach((cleanup) => cleanup())
	}
}
