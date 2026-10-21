import { z } from 'zod'

// The `_canvas/*` ACP extension messages the harness sends to one researcher's browser (group README,
// Shared contracts). They change only that browser's view, never the shared room. Optional fields
// also accept null, since the Python side may send None for "not given".

export const CANVAS_METHODS = {
	focus: '_canvas/focus',
	highlight: '_canvas/highlight',
	openPaper: '_canvas/open_paper',
	tour: '_canvas/tour',
	snapshot: '_canvas/snapshot',
} as const

const sessionId = z.string().min(1)
const ids = z.array(z.string().min(1)).nullish()

export const focusParams = z.object({
	sessionId,
	shapeIds: ids,
	paperIds: ids,
	inset: z.number().nonnegative().nullish(),
	animate: z.boolean().nullish(),
})

export const highlightParams = z.object({
	sessionId,
	shapeIds: ids,
	paperIds: ids,
	durationMs: z.number().nonnegative().nullish(),
})

export const openPaperParams = z.object({ sessionId, paperId: z.string().min(1) })

export const DEFAULT_TOUR_TITLE = 'Catch-up'

export const tourParams = z.object({
	sessionId,
	title: z.string().default(DEFAULT_TOUR_TITLE),
	steps: z.array(z.object({ paperId: z.string().min(1), line: z.string() })),
})

/**
 * A request, not a notification: the agent waits for the picture (T07). `shapes` takes `shapeIds`
 * and/or `paperIds`; there are no PDF pages to draw (decision D25).
 */
export const snapshotParams = z.object({
	sessionId,
	target: z.enum(['viewport', 'board', 'shapes']),
	shapeIds: ids,
	paperIds: ids,
	maxSide: z.number().int().positive().nullish(),
})

/** The browser's answer to `_canvas/snapshot`; it fails with a JSON-RPC error instead when it can't draw. */
export const snapshotResult = z.object({
	mimeType: z.literal('image/png'),
	/** Base64, no data: prefix. */
	data: z.string().min(1),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	caption: z.string(),
})

export type FocusParams = z.infer<typeof focusParams>
export type HighlightParams = z.infer<typeof highlightParams>
export type OpenPaperParams = z.infer<typeof openPaperParams>
export type TourParams = z.infer<typeof tourParams>
export type SnapshotParams = z.infer<typeof snapshotParams>
export type SnapshotResult = z.infer<typeof snapshotResult>
