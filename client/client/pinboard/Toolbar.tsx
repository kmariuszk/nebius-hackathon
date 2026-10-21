import { useValue, type Editor } from 'tldraw'
import { FilterButton } from './FilterPanel'

// The v6 toolbar: a Note to stick on the board or on a paper. tldraw's own tools stay on their
// keyboard shortcuts.
export function PinboardToolbar({ editor }: { editor: Editor }) {
	const noteOn = useValue('note tool', () => editor.getCurrentToolId() === 'note', [editor])
	return (
		<nav className="pb-toolbar" aria-label="Tools">
			<button
				type="button"
				className={`pb-notebtn${noteOn ? ' on' : ''}`}
				onClick={() => editor.setCurrentTool(noteOn ? 'select' : 'note')}
				title="Click the board to stick a note there"
			>
				<span className="mini" />
				Note
			</button>
			<FilterButton editor={editor} />
		</nav>
	)
}
