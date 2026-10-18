import { useState } from 'react'

// Super VL's reasoning, dimmed: open while it streams, collapsed once the answer starts, and
// the researcher's own toggle wins after that.
export function ThoughtBlock({ text, done }: { text: string; done: boolean }) {
	const [toggled, setToggled] = useState<boolean | null>(null)
	const open = toggled ?? !done
	return (
		<div className="ChatThought">
			<button type="button" className="ChatThought-toggle" aria-expanded={open} onClick={() => setToggled(!open)}>
				<span className="ChatCaret" data-open={open}>▸</span>
				{done ? 'Thoughts' : 'Thinking…'}
			</button>
			{open && <div className="ChatThought-text">{text}</div>}
		</div>
	)
}
