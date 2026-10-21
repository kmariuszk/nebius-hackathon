import {
	createShapePropsMigrationIds,
	createShapePropsMigrationSequence,
	type RecordProps,
	type TLShape,
} from '@tldraw/tlschema'
import { T } from '@tldraw/validate'
import { PAPER_CARD_TYPE, type PaperCardProps } from './paperCard.ts'

// Custom shape schemas shared by the sync server and the browser (T01, decision D6). Only
// @tldraw/tlschema and @tldraw/validate here: `tldraw` would pull React and CSS into Node.

declare module '@tldraw/tlschema' {
	interface TLGlobalShapePropsMap {
		'paper-card': PaperCardProps
	}
}

export type PaperCardShape = TLShape<'paper-card'>

const fit = T.literalEnum('low', 'medium', 'high')

export const paperCardProps: RecordProps<PaperCardShape> = {
	w: T.nonZeroNumber,
	h: T.nonZeroNumber,
	paperId: T.string,
	title: T.string,
	authors: T.arrayOf(T.string),
	year: T.nullable(T.integer),
	venue: T.string,
	url: T.string,
	type: T.literalEnum('article', 'review', 'preprint', 'other'),
	typeRaw: T.string,
	peerReviewed: T.nullable(T.boolean),
	citedBy: T.nullable(T.positiveInteger),
	kind: T.literalEnum('seed', 'kept', 'suggestion'),
	status: T.literalEnum('new', 'kept', 'contested', 'discarded'),
	working: T.boolean,
	keepBy: T.arrayOf(T.string),
	discardBy: T.arrayOf(T.string),
	scores: T.dict(T.string, T.object({ score: T.number, fit, why: T.string })),
	figure: T.nullable(
		T.object({ imageUrl: T.string, label: T.string, caption: T.string, captionByAi: T.boolean })
	),
	oneLine: T.string,
	claims: T.arrayOf(T.object({ text: T.string, evidence: T.arrayOf(T.string) })),
	quotes: T.arrayOf(
		T.object({ id: T.string, text: T.string, source: T.string, verified: T.boolean, url: T.string })
	),
	glance: T.arrayOf(
		T.object({
			label: T.string,
			text: T.string,
			quoteId: T.nullable(T.string),
			relation: T.nullable(T.literalEnum('same', 'adds', 'other')),
		})
	),
	summary: T.string,
	gaps: T.arrayOf(T.string),
	foundBy: T.arrayOf(T.string),
	provenance: T.dict(T.string, T.object({ model: T.nullable(T.string), at: T.number })),
}

// Empty for now, so the first prop change is a migration rather than a room that won't open.
export const paperCardVersions = createShapePropsMigrationIds(PAPER_CARD_TYPE, {})
export const paperCardMigrations = createShapePropsMigrationSequence({ sequence: [] })

/** The v6 card every paper is drawn as, centred on its node; the server's layout keeps this much room. */
export const CARD_SIZE = { w: 172, h: 70 } as const

/** Node sizes (w = h) by kind. New cards start at the minimum; nodes no longer grow with their links (D23). */
export const NODE_SIZE = {
	circle: { min: 40, max: 72 },
	square: { min: 48, max: 80 },
} as const

/** Full props for a new card: what the canvas MCP and addShape.ts start from before filling in. */
export function defaultPaperCardProps(
	paperId: string,
	props: Partial<PaperCardProps> = {}
): PaperCardProps {
	const kind = props.kind ?? 'suggestion'
	const size = kind === 'suggestion' ? NODE_SIZE.circle.min : NODE_SIZE.square.min
	return {
		w: size,
		h: size,
		paperId,
		title: '',
		authors: [],
		year: null,
		venue: '',
		url: '',
		type: 'other',
		typeRaw: '',
		peerReviewed: null,
		citedBy: null,
		kind,
		status: 'new',
		working: false,
		keepBy: [],
		discardBy: [],
		scores: {},
		figure: null,
		oneLine: '',
		claims: [],
		quotes: [],
		glance: [],
		summary: '',
		gaps: [],
		foundBy: [],
		provenance: {},
		...props,
	}
}

/** Merged into createTLSchema's `shapes` by the server and passed to the browser's store. */
export const customShapeSchemas = {
	[PAPER_CARD_TYPE]: { props: paperCardProps, migrations: paperCardMigrations },
}
