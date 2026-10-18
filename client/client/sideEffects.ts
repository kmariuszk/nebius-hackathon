import type { Editor } from 'tldraw'

// Attribution and human-touched flags (T01), registered once when the editor mounts.
// Returns a function that removes the handlers. Placeholder until the board model lands.
export function registerBoardSideEffects(_editor: Editor, _memberId: string): () => void {
	return () => {}
}
