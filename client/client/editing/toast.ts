import { atom } from 'tldraw'

// The board's own toasts (T14, T13): note pins, refused deletes, link edits, "Done. The agent
// caught up". Drawn by BoardToast.tsx in the widgets' toast style; the open paper's widgets keep
// their own.

export interface BoardToastAction {
	label: string
	run(): void
}

export interface BoardToast {
	text: string
	/** "Undo", "See what it did": one button after the text. */
	action?: BoardToastAction
}

export const boardToast = atom<(BoardToast & { id: number }) | null>('board toast', null)

let last = 0

export function toast(next: BoardToast | string) {
	boardToast.set({ ...(typeof next === 'string' ? { text: next } : next), id: ++last })
}

/** An Undo button that runs `undo`. */
export const undoAction = (undo: () => void): BoardToastAction => ({ label: 'Undo', run: undo })
