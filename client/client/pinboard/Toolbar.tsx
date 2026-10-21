import { useEffect, useRef, useState, type DragEvent } from 'react'
import { useValue, type Editor, type TLShapeId } from 'tldraw'
import { cardLabel } from '../../shared/display'
import { paperShapeId } from '../../shared/ids'
import { isPaperCard } from '../../shared/paperCard'
import { chatTurns } from '../chat/chatBus'
import { NOTE_DRAG_TYPE } from '../editing/pinNotes'
import { toast } from '../editing/toast'
import { changes, describeChange, updateSuggestions } from './changes'
import { FilterButton } from './FilterPanel'
import { useDismiss } from './useDismiss'

// The v6 toolbar: a Note to stick on the board or on a paper, Filter, and after your edits "N changes ·
// the agent is waiting · Update suggestions". tldraw's own tools stay on their keyboard shortcuts.
export function PinboardToolbar({ editor, boardId }: { editor: Editor; boardId: string }) {
	return (
		<nav className="pb-toolbar" aria-label="Tools">
			<NoteButton editor={editor} />
			<FilterButton editor={editor} />
			<Changes editor={editor} boardId={boardId} />
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

// this viewer's edits since their last Update suggestions (T13, changes.ts); the agent waits for
// the button, and "N changes" lists them in plain words
function Changes({ editor, boardId }: { editor: Editor; boardId: string }) {
	const entries = useValue('my changes', () => changes.get(boardId).entries, [boardId])
	const [open, setOpen] = useState(false)
	const ref = useRef<HTMLDivElement>(null)
	const count = entries.length
	useEffect(() => {
		if (!count) setOpen(false)
	}, [count])
	useDismiss(ref, open, () => setOpen(false))
	if (!count) return null

	const labelOf = (paperId: string) => {
		const card = editor.getShape(paperShapeId(paperId) as TLShapeId)
		return isPaperCard(card) ? cardLabel(card) : paperId
	}
	const update = () => {
		setOpen(false)
		const sent = updateSuggestions(boardId, (turnKey) =>
			toast({
				text: 'Done. The agent caught up with your changes.',
				action: { label: 'See what it did', run: () => chatTurns.show(turnKey) },
			})
		)
		if (sent) toast(`The agent is updating suggestions with your ${sent} change${sent > 1 ? 's' : ''}…`)
	}
	return (
		<div className="pb-changes" ref={ref}>
			<button type="button" className="chgbtn" aria-expanded={open} onClick={() => setOpen(!open)} title="See what changed">
				{count} change{count > 1 ? 's' : ''}
			</button>
			<span>the agent is waiting</span>
			<button type="button" className="sync" onClick={update}>
				Update suggestions
			</button>
			{open && (
				<div className="pb-pop pb-chgpop" role="dialog" aria-label="Your changes">
					<h6>The agent will catch up on</h6>
					<ol className="chglist">
						{entries.map((e) => (
							<li key={e.key}>{describeChange(e.change, labelOf)}</li>
						))}
					</ol>
					<div className="mnote">
						Everyone on the board already sees your edits. The agent waits for <b>Update suggestions</b>, so it doesn’t
						re-rank while you’re still working.
					</div>
				</div>
			)}
		</div>
	)
}
