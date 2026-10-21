import type { DragEvent } from 'react'
import { useValue, type Editor } from 'tldraw'
import { NOTE_DRAG_TYPE } from '../editing/pinNotes'

// The v6 toolbar: a Note to stick on the board or on a paper. tldraw's own tools stay on their
// keyboard shortcuts.
export function PinboardToolbar({ editor }: { editor: Editor }) {
	return (
		<nav className="pb-toolbar" aria-label="Tools">
			<NoteButton editor={editor} />
		</nav>
	)
}

// click it, then click the board or a paper; or drag it onto a paper or the board (T14)
function NoteButton({ editor }: { editor: Editor }) {
	const noteOn = useValue('note tool', () => editor.getCurrentToolId() === 'note', [editor])
	return (
		<button
			type="button"
			draggable
			className={`pb-notebtn${noteOn ? ' on' : ''}`}
			onClick={() => editor.setCurrentTool(noteOn ? 'select' : 'note')}
			onDragStart={startNoteDrag}
			title="Drag a note onto a paper to pin it there, or onto the board"
		>
			<span className="mini" />
			Note
		</button>
	)
}

function startNoteDrag(e: DragEvent) {
	e.dataTransfer.setData(NOTE_DRAG_TYPE, 'note')
	e.dataTransfer.effectAllowed = 'copy'
	const ghost = document.createElement('div')
	ghost.className = 'pb-ghost'
	ghost.textContent = 'Drop on a paper to pin it'
	document.body.appendChild(ghost)
	e.dataTransfer.setDragImage(ghost, 66, 42)
	setTimeout(() => ghost.remove())
}
