import { react, type Editor } from 'tldraw'
import { createdMeta, nextMeta } from './boardRules'
import { registerGuards, userLinkMeta } from './editing/guards'
import { registerPinNotes } from './editing/pinNotes'
import { toast } from './editing/toast'
import { getDisplayName, setDisplayName } from './identity'
import { changes, shapeEdit, watchBoard } from './pinboard/changes'
import { noteArrival } from './shapes/arrivals'
import { plainText } from './widgets/notes'

// Attribution and human-touched flags (T01), registered once when the editor mounts; the rules
// themselves are in boardRules.ts. Also what people may not delete, notes pinning to the paper
// they're put down on (T14), and this viewer's edits for Update suggestions (T13). Returns a
// function that removes the handlers.
export function registerBoardSideEffects(editor: Editor, memberId: string, boardId: string): () => void {
	const name = getDisplayName()
	if (name && name !== editor.user.getName()) editor.user.updateUserPreferences({ name })

	const cleanups = [
		editor.sideEffects.registerBeforeCreateHandler('shape', (shape, source) => {
			let meta = createdMeta(shape.meta, source, memberId)
			if (source === 'user' && shape.type === 'arrow') meta = userLinkMeta(meta, memberId)
			return meta === shape.meta ? shape : { ...shape, meta }
		}),
		editor.sideEffects.registerBeforeChangeHandler('shape', (prev, next, source) => {
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
			if (source !== 'user') return
			const edit = shapeEdit(prev, next)
			if (edit) changes.record(boardId, edit)
			else if (next.type === 'note' && prev.type === 'note' && prev.props.richText !== next.props.richText) {
				changes.noteText(boardId, next.id, plainText(next.props.richText))
			}
		}),
		editor.sideEffects.registerAfterDeleteHandler('shape', (shape, source) => {
			if (source === 'user' && shape.type === 'note') changes.noteDeleted(boardId, shape.id)
		}),
		// a name set in tldraw's people menu is kept for the next visit
		react('display name', () => {
			const current = editor.user.getName()
			if (current && current !== getDisplayName()) setDisplayName(current)
		}),
	]
	return () => cleanups.forEach((cleanup) => cleanup())
}
