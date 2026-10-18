import type { Editor } from 'tldraw'

export interface ChatPanelProps {
	boardId: string
	memberId: string
	/** Null until the canvas has mounted. */
	editor: Editor | null
}

// The chat panel (T05). Placeholder until the ACP client lands.
export function ChatPanel(_props: ChatPanelProps) {
	return null
}
