// Custom binding schemas shared by the sync server and the browser (T01). The schemas are a
// placeholder until the board model lands; the server merges them into its schema.
export const customBindingSchemas = {}

/** A built-in note pinned to a paper card: `fromId` is the note, `toId` the `paper-card`. */
export const NOTE_PIN_TYPE = 'note-pin'

export interface NotePinProps {
	/** The note's top-left minus the paper card's top-left, in page space; kept as the card moves. */
	dx: number
	dy: number
}
