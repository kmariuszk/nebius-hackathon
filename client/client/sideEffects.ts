import { react, type Editor, type TLShapeId } from 'tldraw'
import { NOTE_PIN_TYPE } from '../shared/bindings.ts'
import { isPaperCard } from '../shared/paperCard.ts'
import { createdMeta, nextMeta } from './boardRules.ts'
import { isGuardReparent, registerGuards, userLinkMeta } from './editing/guards.ts'
import { registerPinNotes } from './editing/pinNotes.ts'
import { toast } from './editing/toast.ts'
import { getDisplayName, setDisplayName } from './identity.ts'
import { changes, shapeEdit, watchBoard } from './pinboard/changes.ts'
import { noteArrival } from './shapes/arrivals.ts'
import { plainText } from './widgets/notes.ts'

// Attribution and human-touched flags (T01), registered once when the editor mounts; the rules
// themselves are in boardRules.ts. Also what people may not delete, notes pinning to the paper
// they're put down on (T14), and this viewer's edits for Update suggestions (T13). Returns a
// function that removes the handlers.
export function registerBoardSideEffects(editor: Editor, memberId: string, boardId: string): () => void {
	const name = getDisplayName()
	if (name && name !== editor.user.getName()) editor.user.updateUserPreferences({ name })

	const pinsGoing = new Map<TLShapeId, TLShapeId>()
	const cleanups = [
		editor.sideEffects.registerBeforeCreateHandler('shape', (shape, source) => {
			let meta = createdMeta(shape.meta, source, memberId)
			if (source === 'user' && shape.type === 'arrow') meta = userLinkMeta(meta, memberId)
			return meta === shape.meta ? shape : { ...shape, meta }
		}),
		editor.sideEffects.registerBeforeChangeHandler('shape', (prev, next, source) => {
			if (isGuardReparent()) return next
			const meta = nextMeta(prev, next, source)
			return meta === next.meta ? next : { ...next, meta }
		}),
		// cards the agent adds from now on arrive one by one; the ones loaded with the room don't
		editor.sideEffects.registerAfterCreateHandler('shape', (shape) => {
			if (shape.type === 'paper-card') noteArrival(shape.id)
		}),
		watchBoard(editor, boardId),
		registerGuards(editor, toast),
		registerPinNotes(editor),
		// papers moved, clusters renamed, and the text of notes added since the last update
		editor.sideEffects.registerAfterChangeHandler('shape', (prev, next, source) => {
			if (source !== 'user' || isGuardReparent()) return
			if (next.type === 'arrow' && prev.meta.hiddenByHuman === true && next.meta.hiddenByHuman !== true) {
				changes.linkShapeBack(boardId, next.id)
			}
			const edit = shapeEdit(prev, next)
			if (edit) changes.record(boardId, edit)
			else if (next.type === 'note' && prev.type === 'note' && prev.props.richText !== next.props.richText) {
				changes.noteText(boardId, next.id, plainText(next.props.richText))
			}
		}),
		editor.sideEffects.registerAfterCreateHandler('shape', (shape, source) => {
			if (source === 'user' && shape.type === 'arrow') changes.linkShapeBack(boardId, shape.id)
		}),
		// a deleted note's pin goes before the note does, so the paper it was on is noted on the way
		editor.sideEffects.registerBeforeDeleteHandler('binding', (binding) => {
			if (binding.type === NOTE_PIN_TYPE) pinsGoing.set(binding.fromId, binding.toId)
		}),
		editor.sideEffects.registerOperationCompleteHandler(() => pinsGoing.clear()),
		editor.sideEffects.registerAfterDeleteHandler('shape', (shape, source) => {
			if (source !== 'user') return
			if (shape.type === 'note') {
				const pin = pinsGoing.get(shape.id)
				const card = pin ? editor.getShape(pin) : undefined
				const paperId = isPaperCard(card) ? card.props.paperId : undefined
				changes.noteDeleted(boardId, shape.id, plainText(shape.props.richText), paperId)
			}
			if (shape.type === 'arrow') changes.linkShapeGone(boardId, shape.id)
		}),
		// a name set in tldraw's people menu is kept for the next visit
		react('display name', () => {
			const current = editor.user.getName()
			if (current && current !== getDisplayName()) setDisplayName(current)
		}),
	]
	return () => cleanups.forEach((cleanup) => cleanup())
}
