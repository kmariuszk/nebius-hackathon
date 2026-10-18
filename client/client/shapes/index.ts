import type { Editor, TLAnyBindingUtilConstructor, TLAnyShapeUtilConstructor, TLShape } from 'tldraw'
import { NOTE_PIN_TYPE } from '../../shared/bindings'
import { linkedCards } from '../pinboard/Strings'
import { filters } from '../viewerState'
import { NotePinBindingUtil } from './NotePinBindingUtil'
import { PaperCardShapeUtil } from './PaperCardShapeUtil'

// Custom shape and binding utils for the browser (T01); the server knows the same schemas
// through client/shared.
export const customShapeUtils: TLAnyShapeUtilConstructor[] = [PaperCardShapeUtil]
export const customBindingUtils: TLAnyBindingUtilConstructor[] = [NotePinBindingUtil]

/**
 * Passed to `<Tldraw getShapeVisibility>`: hides discarded papers unless this viewer shows them,
 * links a person hid, and links and pinned notes whose paper is hidden. Reads the filters atom,
 * so toggling "Show discarded papers" changes this browser only.
 */
export function getShapeVisibility(shape: TLShape, editor?: Editor): 'visible' | 'hidden' | 'inherit' {
	if (shape.type === 'paper-card') {
		return shape.props.status === 'discarded' && !filters.get().showDiscarded ? 'hidden' : 'inherit'
	}
	if (shape.type === 'arrow') {
		if (shape.meta.hiddenByHuman === true) return 'hidden'
		if (editor && boundToHidden(editor, shape, 'arrow')) return 'hidden'
		// links between papers are drawn as strings (pinboard/Strings.tsx), not as arrows
		if (editor && linkedCards(editor, shape)) return 'hidden'
	}
	if (shape.type === 'note' && editor && boundToHidden(editor, shape, NOTE_PIN_TYPE)) return 'hidden'
	return 'inherit'
}

function boundToHidden(editor: Editor, shape: TLShape, type: 'arrow' | typeof NOTE_PIN_TYPE) {
	return editor
		.getBindingsFromShape(shape, type)
		.some((b) => editor.getShape(b.toId)?.type === 'paper-card' && editor.isShapeHidden(b.toId))
}
