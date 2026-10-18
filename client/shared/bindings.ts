import {
	createBindingPropsMigrationIds,
	createBindingPropsMigrationSequence,
	type RecordProps,
	type TLBinding,
} from '@tldraw/tlschema'
import { T } from '@tldraw/validate'

// Custom binding schemas shared by the sync server and the browser (T01); the server merges
// them into its schema.

/** A built-in note pinned to a paper card: `fromId` is the note, `toId` the `paper-card`. */
export const NOTE_PIN_TYPE = 'note-pin'

export interface NotePinProps {
	/** The note's top-left minus the paper card's top-left, in page space; kept as the card moves. */
	dx: number
	dy: number
}

declare module '@tldraw/tlschema' {
	interface TLGlobalBindingPropsMap {
		'note-pin': NotePinProps
	}
}

export type NotePinBinding = TLBinding<'note-pin'>

export const notePinProps: RecordProps<NotePinBinding> = {
	dx: T.number,
	dy: T.number,
}

export const notePinVersions = createBindingPropsMigrationIds(NOTE_PIN_TYPE, {})
export const notePinMigrations = createBindingPropsMigrationSequence({ sequence: [] })

export const customBindingSchemas = {
	[NOTE_PIN_TYPE]: { props: notePinProps, migrations: notePinMigrations },
}
