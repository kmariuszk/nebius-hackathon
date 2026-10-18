import { BindingUtil, type BindingOnShapeChangeOptions } from 'tldraw'
import { NOTE_PIN_TYPE, notePinMigrations, notePinProps, type NotePinBinding } from '../../shared/bindings'

type Options = BindingOnShapeChangeOptions<NotePinBinding>

const near = (a: number, b: number) => Math.abs(a - b) < 0.5

/**
 * A built-in note pinned to a paper card, after tldraw's sticker-bindings example: the note keeps
 * its offset as the paper moves, and stays (unpinned) when the paper is deleted, because the
 * editor removes the binding along with the paper.
 */
export class NotePinBindingUtil extends BindingUtil<NotePinBinding> {
	static override type = NOTE_PIN_TYPE
	static override props = notePinProps
	static override migrations = notePinMigrations

	override getDefaultProps() {
		return { dx: 0, dy: 0 }
	}

	// the paper moved: bring the note along
	override onAfterChangeToShape({ binding, shapeAfter }: Options) {
		const note = this.editor.getShape(binding.fromId)
		if (!note) return
		const paper = this.editor.getShapePageTransform(shapeAfter).point()
		const target = { x: paper.x + binding.props.dx, y: paper.y + binding.props.dy }
		const current = this.editor.getShapePageTransform(note).point()
		if (near(current.x, target.x) && near(current.y, target.y)) return
		const { x, y } = this.editor.getPointInParentSpace(note, target)
		this.editor.updateShape({ id: note.id, type: note.type, x, y })
	}

	// the note itself was moved: keep its new place next to the paper
	override onAfterChangeFromShape({ binding, shapeAfter }: Options) {
		const paper = this.editor.getShape(binding.toId)
		if (!paper) return
		const p = this.editor.getShapePageTransform(paper).point()
		const n = this.editor.getShapePageTransform(shapeAfter).point()
		const dx = n.x - p.x
		const dy = n.y - p.y
		if (near(dx, binding.props.dx) && near(dy, binding.props.dy)) return
		this.editor.updateBinding({ id: binding.id, type: binding.type, props: { dx, dy } })
	}
}
