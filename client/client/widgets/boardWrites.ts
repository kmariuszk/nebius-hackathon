import { createShapeId, toRichText, type Editor } from 'tldraw'
import { NOTE_PIN_TYPE } from '../../shared/bindings.ts'
import type { PaperCardShape } from '../../shared/shapes.ts'
import { NOTE_SCALE, newNoteOffset } from './notes.ts'

// The one shared write the widgets make besides votes: "Add a note" puts a built-in note beside
// the paper and pins it there, so it shows for everyone and moves with the paper (T01).

export function addPinnedNote(editor: Editor, card: PaperCardShape, text: string, memberId: string) {
	const pinned = editor.getBindingsToShape(card.id, NOTE_PIN_TYPE).length
	const at = editor.getShapePageTransform(card).point()
	const { dx, dy } = newNoteOffset(card.props, pinned)
	const id = createShapeId()
	editor.markHistoryStoppingPoint('add pinned note')
	editor.run(() => {
		editor.createShape({
			id,
			type: 'note',
			x: at.x + dx,
			y: at.y + dy,
			props: { richText: toRichText(text), size: 's', font: 'sans', align: 'start', verticalAlign: 'start', scale: NOTE_SCALE },
			meta: { author: memberId },
		})
		editor.createBinding({ type: NOTE_PIN_TYPE, fromId: id, toId: card.id, props: { dx, dy } })
	})
	return id
}
