import { atom, type TLShapeId } from 'tldraw'

// Which string this viewer points at, and which one the link editor is open on (per viewer,
// never in the room): the strings draw both "on", with their pill.

export const hoveredLink = atom<TLShapeId | null>('hovered link', null)

/** The arrow behind the string, and where the editor opens, in the canvas's own coordinates. */
export const linkEditorAt = atom<{ arrowId: TLShapeId; x: number; y: number } | null>('link editor', null)

export function openLinkEditor(arrowId: TLShapeId, at: { x: number; y: number }) {
	linkEditorAt.set({ arrowId, x: at.x, y: at.y })
}
