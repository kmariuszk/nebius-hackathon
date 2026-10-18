import { react, type Editor } from 'tldraw'
import { createdMeta, nextMeta } from './boardRules'
import { getDisplayName, setDisplayName } from './identity'
import { noteArrival } from './shapes/arrivals'

// Attribution and human-touched flags (T01), registered once when the editor mounts; the rules
// themselves are in boardRules.ts. Returns a function that removes the handlers.
export function registerBoardSideEffects(editor: Editor, memberId: string): () => void {
	const name = getDisplayName()
	if (name && name !== editor.user.getName()) editor.user.updateUserPreferences({ name })

	const cleanups = [
		editor.sideEffects.registerBeforeCreateHandler('shape', (shape, source) => {
			const meta = createdMeta(shape.meta, source, memberId)
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
		// a name set in tldraw's people menu is kept for the next visit
		react('display name', () => {
			const current = editor.user.getName()
			if (current && current !== getDisplayName()) setDisplayName(current)
		}),
	]
	return () => cleanups.forEach((cleanup) => cleanup())
}
