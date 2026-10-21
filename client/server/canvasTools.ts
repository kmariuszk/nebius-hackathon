import {
	createBindingId,
	toRichText,
	type TLArrowShape,
	type TLBinding,
	type TLFrameShape,
	type TLNoteShape,
	type TLParentId,
	type TLRecord,
	type TLShape,
	type TLShapeId,
} from '@tldraw/tlschema'
import type { JsonObject } from '@tldraw/utils'
import { z } from 'zod'
import { NOTE_PIN_TYPE } from '../shared/bindings.ts'
import { nodeLabel, normaliseType } from '../shared/display.ts'
import { agentShapeId, clusterShapeId, linkShapeId, paperShapeId, slug, type LinkKind } from '../shared/ids.ts'
import { isAgentShape, isHumanTouched } from '../shared/meta.ts'
import type { PaperCardProps, PaperQuote } from '../shared/paperCard.ts'
import { defaultPaperCardProps, type PaperCardShape } from '../shared/shapes.ts'
import { boardInfo as readBoardInfo } from './boardDb.ts'
import { recordEvent as recordFeedEvent } from './events.ts'
import { centre, footprint, isFree, MARGIN, placeInside, placeNear, shapeBoxes, type Vec } from './layout.ts'
import type { PapersClient } from './papersClient.ts'
import { readRoom, writeRoom, writer, type Txn } from './rooms.ts'

// The canvas MCP's tools (T02) as plain functions, so they can be tested without MCP. Each call
// is one room transaction. Creates are insert-only and updates are merging patches (D20); the
// human-touched rules are enforced here: an agent never moves a shape a person moved, never
// changes props a person edited, never changes people's shapes (it may bind to them), never deletes.

export interface ToolContext {
	boardId: string
	/** The member the agent works for, from the bearer. */
	onBehalfOf: string
	/** X-Run-Id: one per prompt turn; null for external agents. */
	runId: string | null
	/** X-Model, recorded per card field by set_card for the "AI" labels. */
	model: string | null
	papers: PapersClient
}

/** A mistake the agent can fix; the MCP turns it into a tool error with this message. */
export class ToolError extends Error {}

export interface RemovedLink {
	from: string
	to: string
	kind: LinkKind
}

export interface BoardInfo {
	question: string
	goals: string[]
	discardedIds: string[]
	removedLinks: RemovedLink[]
}

/** The board's question, goals (IDs), papers only discarded so far and links people removed, from T08's board DB. */
export const boardInfo = (boardId: string): BoardInfo => readBoardInfo(boardId)

export interface BoardEvent {
	boardId: string
	actor: 'agent'
	onBehalfOf: string
	runId: string | null
	type: string
	payload: unknown
}

/** Stored in the activity feed and streamed over SSE (events.ts); never throws. */
export const recordEvent = (event: BoardEvent) => recordFeedEvent(event)

export function changed(ctx: ToolContext, type: string, payload: unknown) {
	recordEvent({ boardId: ctx.boardId, actor: 'agent', onBehalfOf: ctx.onBehalfOf, runId: ctx.runId, type, payload })
}

export const agentMeta = (ctx: ToolContext, extra: JsonObject = {}): JsonObject => ({
	createdBy: 'agent',
	onBehalfOf: ctx.onBehalfOf,
	runId: ctx.runId,
	...extra,
})

export const isShape = (r: TLRecord | undefined): r is TLShape => r?.typeName === 'shape'
export const isCard = (r: TLRecord | undefined): r is PaperCardShape => isShape(r) && r.type === 'paper-card'
const isBinding = (r: TLRecord): r is TLBinding => r.typeName === 'binding'

// slugs are lossy, so two paper IDs can share a shape ID; the card's own paperId decides
export function findCard(txn: Txn, paperId: string): PaperCardShape | undefined {
	const r = txn.get(paperShapeId(paperId))
	return isCard(r) && r.props.paperId === paperId ? r : undefined
}

function needCard(txn: Txn, paperId: string): PaperCardShape {
	const card = findCard(txn, paperId)
	if (!card) throw new ToolError(`No card for ${paperId} on this board; add it with add_papers first`)
	return card
}

/** Why the agent may not change this shape's props, or null if it may. */
export function propsLocked(shape: TLShape): string | null {
	if (!isAgentShape(shape.meta)) return 'made by a person'
	if (shape.meta.editedByHuman === true) return 'edited by a person'
	return null
}

const normalise = (text: string) => text.replace(/\s+/g, ' ').trim()

/** Text of a TipTap doc: paragraphs on their own lines. */
function plainText(node: unknown): string {
	const n = node as { type?: string; text?: string; content?: unknown[] } | null
	if (n?.type === 'text') return n.text ?? ''
	return (n?.content ?? []).map(plainText).join(n?.type === 'doc' ? '\n' : '')
}

// Agents never delete, so a link ID with a tombstone was removed by a person. Tombstones are
// pruned after a few thousand deletes; T08's board DB keeps removed links for good.
function deletedLinkIds(txn: Txn): Set<string> {
	const changes = txn.getChangesSince(0)
	if (!changes || changes.wipeAll) return new Set()
	return new Set(changes.diff.deletes.filter((id) => id.startsWith('shape:link-')))
}

// ---- get_board

const PAPER_CAP = 500
const LINK_CAP = 1000
const NOTE_CAP = 200

export function getBoard(ctx: ToolContext) {
	const info = boardInfo(ctx.boardId)
	return readRoom(ctx.boardId, (txn) => {
		const records = [...txn.values()]
		const byId = new Map<string, TLRecord>(records.map((r) => [r.id, r]))
		const shapes = records.filter(isShape)
		const bindings = records.filter(isBinding)
		const cards = shapes.filter(isCard)
		const paperIdOf = (id: string) => {
			const r = byId.get(id)
			return isCard(r) ? r.props.paperId : null
		}

		const pinnedTo = new Map<string, string | null>()
		const pinCount = new Map<string, number>()
		const ends = new Map<string, { start?: string | null; end?: string | null }>()
		for (const b of bindings) {
			if (b.type === NOTE_PIN_TYPE) {
				pinnedTo.set(b.fromId, paperIdOf(b.toId))
				pinCount.set(b.toId, (pinCount.get(b.toId) ?? 0) + 1)
			} else if (b.type === 'arrow') {
				ends.set(b.fromId, { ...ends.get(b.fromId), [b.props.terminal]: paperIdOf(b.toId) })
			}
		}

		const rank = (c: PaperCardShape) => (c.props.kind === 'suggestion' ? 1 : 0)
		cards.sort((a, b) => rank(a) - rank(b) || (a.index < b.index ? -1 : 1))
		const papers = cards.slice(0, PAPER_CAP).map(({ id, parentId, meta, props: p }) => {
			const frame = byId.get(parentId)
			return {
				paperId: p.paperId,
				label: nodeLabel(p.authors, p.year),
				title: p.title,
				year: p.year,
				type: p.type,
				kind: p.kind,
				status: p.status,
				scores: Object.fromEntries(
					Object.entries(p.scores).map(([goal, s]) => [goal, { score: s.score, fit: s.fit }])
				),
				working: p.working,
				cluster: isShape(frame) && typeof frame.meta.clusterId === 'string' ? frame.meta.clusterId : null,
				humanTouched: isHumanTouched(meta),
				pinnedNotes: pinCount.get(id) ?? 0,
			}
		})

		const links = []
		for (const [arrowId, { start, end }] of ends) {
			const arrow = byId.get(arrowId)
			if (!start || !end || !isShape(arrow) || arrow.type !== 'arrow') continue
			const m = arrow.meta
			links.push({
				from: start,
				to: end,
				kind: typeof m.kind === 'string' ? m.kind : 'user',
				label: (typeof m.label === 'string' && m.label) || plainText(arrow.props.richText),
				by: String(m.by ?? m.author ?? ''),
				...(m.hiddenByHuman === true ? { hidden: true } : {}),
			})
		}

		const notes = shapes
			.filter((s): s is TLNoteShape => s.type === 'note')
			.slice(0, NOTE_CAP)
			.map((n) => ({
				shapeId: n.id,
				text: plainText(n.props.richText).slice(0, 500),
				author: typeof n.meta.author === 'string' ? n.meta.author : isAgentShape(n.meta) ? 'agent' : '',
				pinnedTo: pinnedTo.get(n.id) ?? null,
			}))

		// a cluster's papers are the cards inside its frame (`cluster` on each paper)
		const clusters = shapes
			.filter((s): s is TLFrameShape => clusterIdOf(s) !== null)
			.map((f) => ({
				clusterId: f.meta.clusterId as string,
				label: f.props.name,
				labelGenerated: f.meta.labelGenerated === true,
				humanTouched: isHumanTouched(f.meta) || f.meta.renamedByHuman === true,
			}))

		const discarded = cards.filter((c) => c.props.status === 'discarded').map((c) => c.props.paperId)
		const bySlug = new Map(cards.map((c) => [slug(c.props.paperId), c.props.paperId]))
		const removed = [...deletedLinkIds(txn)].map((id) => parseLinkId(id, bySlug)).filter((l) => l !== null)
		return {
			boardId: ctx.boardId,
			question: info.question,
			goals: info.goals,
			papers,
			...(cards.length > PAPER_CAP ? { truncated: cards.length - PAPER_CAP } : {}),
			links: links.slice(0, LINK_CAP),
			notes,
			clusters,
			discardedIds: [...new Set([...info.discardedIds, ...discarded])],
			removedLinks: [...info.removedLinks, ...removed],
		}
	})
}

// `shape:link-<kind>-<from>--<to>` back to paper IDs; slugs may contain "--", so try each split
function parseLinkId(id: string, bySlug: Map<string, string>): RemovedLink | null {
	const m = id.match(/^shape:link-(cites|similar|user)-(.+)$/)
	if (!m) return null
	for (let i = m[2].indexOf('--'); i >= 0; i = m[2].indexOf('--', i + 1)) {
		const from = bySlug.get(m[2].slice(0, i))
		const to = bySlug.get(m[2].slice(i + 2))
		if (from && to) return { from, to, kind: m[1] as LinkKind }
	}
	return null
}

// ---- add_papers

export const paperIdInput = z.string().min(1).max(200)
const httpUrl = z.string().max(2000).regex(/^https?:\/\//, 'must be an http(s) URL')

const paperInput = z.object({
	paperId: paperIdInput,
	title: z.string().min(1).max(1000),
	authors: z.array(z.string().max(200)).max(200).nullish(),
	year: z.number().int().min(1000).max(2200).nullish(),
	venue: z.string().max(500).nullish(),
	url: httpUrl.nullish(),
	type: z.string().max(100).nullish(),
	peerReviewed: z.boolean().nullish(),
	citedBy: z.number().int().min(0).nullish(),
	retracted: z.boolean().nullish(),
	kind: z.enum(['seed', 'kept', 'suggestion']).nullish(),
	near: paperIdInput.nullish(),
	foundBy: z.array(z.string().max(200)).max(20).nullish(),
})

const addPapersInput = { papers: z.array(paperInput).min(1).max(50) }

const NEW_CARD_SIZE = 48

// null means unknown: it never overwrites what a card already says
function cardFields(p: z.infer<typeof paperInput>): Partial<PaperCardProps> {
	const f: Partial<PaperCardProps> = { title: p.title }
	if (p.authors) f.authors = p.authors
	if (p.year != null) f.year = p.year
	if (p.venue != null) f.venue = p.venue
	if (p.url != null) f.url = p.url
	if (p.type != null) Object.assign(f, { type: normaliseType(p.type), typeRaw: p.type })
	if (p.peerReviewed != null) f.peerReviewed = p.peerReviewed
	if (p.citedBy != null) f.citedBy = p.citedBy
	if (p.foundBy) f.foundBy = p.foundBy
	return f
}

// The `near` card's centre; else the first card from this run, so a run's papers ring around one
// point instead of running off in a row; else null (right of the content).
function anchorFor(records: TLRecord[], txn: Txn, near: string | null | undefined, runId: string | null): Vec | null {
	const boxes = shapeBoxes(records)
	const nearCard = near ? findCard(txn, near) : undefined
	if (nearCard && boxes.has(nearCard.id)) return centre(boxes.get(nearCard.id)!)
	if (!runId) return null
	let first: PaperCardShape | undefined
	for (const r of records) if (isCard(r) && r.meta.runId === runId && (!first || r.index < first.index)) first = r
	return first && boxes.has(first.id) ? centre(boxes.get(first.id)!) : null
}

// ---- cluster frames: built-in frames with meta.clusterId (apply_clusters and label_cluster are in clusterTools.ts)

const clusterIdOf = (r: TLRecord | undefined) =>
	isShape(r) && r.type === 'frame' && typeof r.meta.clusterId === 'string' ? r.meta.clusterId : null

/** The frame that holds cluster `clusterId`: ours by its ID, else one a person made (T14). */
export function findClusterFrame(txn: Txn, clusterId: string): TLFrameShape | undefined {
	const own = txn.get(clusterShapeId(clusterId))
	if (clusterIdOf(own) === clusterId) return own as TLFrameShape
	for (const r of txn.values()) if (clusterIdOf(r) === clusterId) return r as TLFrameShape
	return undefined
}

/**
 * A free spot for a box of `size` inside `frame`, in the frame's own coordinates, nearest the
 * anchor (page space). If the frame is full and is the agent's, untouched by people, it grows
 * downwards when the space below it is free, else one card column to the right when that is free.
 * Null if there is no room.
 */
export function spotInFrame(txn: Txn, frameId: TLShapeId, size: { w: number; h: number }, anchor: Vec | null) {
	const frame = txn.get(frameId) as TLFrameShape
	const records = [...txn.values()]
	const box = shapeBoxes(records).get(frame.id)!
	const local = (at: Vec) => ({ x: at.x - box.x, y: at.y - box.y })
	const at = placeInside(records, size, anchor, frame.id)
	if (at) return local(at)
	if (propsLocked(frame)) return null
	const room = footprint({ x: 0, y: 0, ...size })
	const down = Math.max(room.w, room.h) + 2 * MARGIN
	const across = room.w + 2 * MARGIN
	const inFrame = new Set<string>([frame.id])
	for (const r of records) if (isShape(r) && inFrame.has(r.parentId)) inFrame.add(r.id)
	const outside = [...shapeBoxes(records)].filter(([id]) => !inFrame.has(id)).map(([, b]) => b)
	if (isFree(outside, { x: box.x, y: box.y + box.h, w: box.w, h: down })) {
		const grown = { ...frame, props: { ...frame.props, h: frame.props.h + down } }
		const below = placeInside(records.map((r) => (r.id === frame.id ? grown : r)), size, anchor, frame.id)
		if (below) {
			writer(txn).patchShape({ id: frame.id, props: { h: grown.props.h } })
			return local(below)
		}
	}
	const column = { x: box.x + box.w, y: box.y, w: across, h: box.h }
	if (box.h < room.h + 2 * MARGIN || !isFree(outside, column)) return null
	const top = box.y + MARGIN + room.h / 2
	const y = Math.min(Math.max((anchor ?? centre(box)).y, top), box.y + box.h - MARGIN - room.h / 2)
	const spot = { x: Math.round(column.x + across / 2 - size.w / 2), y: Math.round(y - size.h / 2) }
	const others = [...shapeBoxes(records)].filter(([id]) => id !== frame.id).map(([, b]) => b)
	if (!isFree(others, footprint({ ...spot, ...size }))) return null
	writer(txn).patchShape({ id: frame.id, props: { w: frame.props.w + across } })
	return local(spot)
}

// A new card goes beside its `near` card, inside that card's cluster frame while it has room;
// `near` may also name a cluster. Otherwise on the page, as placeNear does.
function placeCard(
	txn: Txn,
	size: { w: number; h: number },
	near: string | null | undefined,
	runId: string | null
): Vec & { parentId?: TLParentId } {
	const records = [...txn.values()]
	const nearCard = near ? findCard(txn, near) : undefined
	const container = nearCard ? txn.get(nearCard.parentId) : near ? findClusterFrame(txn, near) : undefined
	const frame = clusterIdOf(container) !== null ? (container as TLFrameShape) : undefined
	const anchor =
		frame && !nearCard ? centre(shapeBoxes(records).get(frame.id)!) : anchorFor(records, txn, near, runId)
	if (frame) {
		const spot = spotInFrame(txn, frame.id, size, anchor)
		if (spot) return { ...spot, parentId: frame.id }
	}
	return placeNear([...txn.values()], size, anchor)
}

export function addPapers(ctx: ToolContext, { papers }: z.infer<z.ZodObject<typeof addPapersInput>>) {
	const result = writeRoom(ctx.boardId, (txn) => {
		const w = writer(txn)
		const added: string[] = []
		const updated: string[] = []
		const skipped: { paperId: string; reason: string }[] = []
		for (const p of papers) {
			const skip = (reason: string) => skipped.push({ paperId: p.paperId, reason })
			if (p.retracted) {
				skip('retracted')
				continue
			}
			const id = paperShapeId(p.paperId) as TLShapeId
			const current = txn.get(id)
			const card = findCard(txn, p.paperId)
			if (current && !card) {
				skip('another shape already has this paper’s shape ID')
				continue
			}
			if (card) {
				const reason =
					card.props.kind === 'seed'
						? 'a seed already on the board'
						: (propsLocked(card) ?? (card.meta.pinnedByHuman === true ? 'moved by a person' : null))
				if (reason) skip(reason)
				else {
					w.patchShape({ id, props: cardFields(p), meta: agentMeta(ctx, { paperId: p.paperId }) })
					updated.push(p.paperId)
				}
				continue
			}
			const size = { w: NEW_CARD_SIZE, h: NEW_CARD_SIZE }
			w.createShape({
				id,
				type: 'paper-card',
				...placeCard(txn, size, p.near, ctx.runId),
				props: defaultPaperCardProps(p.paperId, {
					...cardFields(p),
					...size,
					kind: p.kind ?? 'suggestion',
					status: 'new',
					working: true,
				}),
				meta: agentMeta(ctx, { paperId: p.paperId }),
			})
			added.push(p.paperId)
		}
		return { added, updated, skipped }
	})
	const { added, updated } = result
	if (added.length || updated.length) changed(ctx, 'add_papers', { added, updated })
	return result
}

// ---- set_scores

const goalScore = z.object({
	score: z.number().min(0).max(1),
	fit: z.enum(['low', 'medium', 'high']),
	why: z.string().max(200),
})

const setScoresInput = {
	paperId: paperIdInput,
	scores: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'goal IDs look like new-findings'), goalScore),
}

export function setScores(ctx: ToolContext, { paperId, scores }: z.infer<z.ZodObject<typeof setScoresInput>>) {
	const { goals } = boardInfo(ctx.boardId)
	const unknown = Object.keys(scores).filter((g) => !goals.includes(g))
	if (goals.length && unknown.length) {
		throw new ToolError(`Not a goal of this board: ${unknown.join(', ')}. Its goals are ${goals.join(', ')}`)
	}
	if (!Object.keys(scores).length) throw new ToolError('Give a score for at least one goal')
	const result = writeRoom(ctx.boardId, (txn) => {
		const card = needCard(txn, paperId)
		const locked = propsLocked(card)
		if (locked) return { ok: false, skipped: locked }
		writer(txn).patchShape({
			id: card.id,
			props: { scores: { ...card.props.scores, ...scores } },
			meta: agentMeta(ctx, { paperId }),
		})
		return { ok: true }
	})
	if (result.ok) changed(ctx, 'set_scores', { paperId, goals: Object.keys(scores) })
	return result
}

// ---- set_card

const quoteIdInput = z.string().min(1).max(40)

const setCardInput = {
	paperId: paperIdInput,
	oneLine: z.string().max(400).optional(),
	claims: z
		.array(z.object({ text: z.string().min(1).max(200), evidence: z.array(quoteIdInput).min(1).max(6) }))
		.max(8)
		.optional(),
	glance: z
		.array(
			z.object({
				label: z.string().min(1).max(40),
				text: z.string().min(1).max(200),
				quoteId: quoteIdInput.nullable(),
				relation: z.enum(['same', 'adds', 'other']).nullable(),
			})
		)
		.min(3)
		.max(4)
		.optional(),
	figure: z
		.object({
			imageUrl: z.string().max(2000).regex(/^https:\/\//, 'must be an https URL'),
			label: z.string().max(40),
			caption: z.string().max(1500),
			captionByAi: z.boolean(),
		})
		.nullable()
		.optional(),
	summary: z.string().max(1500).optional(),
	gaps: z.array(z.string().min(1).max(300)).max(8).optional(),
}

export function setCard(ctx: ToolContext, input: z.infer<z.ZodObject<typeof setCardInput>>) {
	const { paperId, oneLine, claims, glance, figure, summary, gaps } = input
	if ([oneLine, claims, glance, figure, summary, gaps].every((v) => v === undefined)) {
		throw new ToolError('Nothing to set: give at least one of oneLine, claims, glance, figure, summary, gaps')
	}
	const result = writeRoom(ctx.boardId, (txn) => {
		const card = needCard(txn, paperId)
		const locked = propsLocked(card)
		if (locked) return { ok: false, skipped: locked }
		const p = card.props
		const quoteIds = new Set(p.quotes.map((q) => q.id))
		const missing = (ids: (string | null)[]) => ids.filter((id) => id !== null && id !== 'seeds' && !quoteIds.has(id))
		const noQuote = (ids: (string | null)[]) =>
			`${missing(ids).join(', ')}: no such quote on this card; add it with add_quote first ` +
			`(quotes so far: ${[...quoteIds].join(', ') || 'none'})`
		const line = oneLine ?? p.oneLine
		const props: Partial<PaperCardProps> = {}

		if (oneLine !== undefined) props.oneLine = oneLine
		if (claims) {
			for (const c of claims) {
				if (!line.includes(c.text)) throw new ToolError(`Claim "${c.text}" must appear word for word in oneLine`)
				if (missing(c.evidence).length) throw new ToolError(`Claim "${c.text}" cites ${noQuote(c.evidence)}`)
			}
			props.claims = claims
		} else if (oneLine !== undefined && p.claims.some((c) => !line.includes(c.text))) {
			props.claims = p.claims.filter((c) => line.includes(c.text))
		}
		if (glance) {
			const ids = glance.map((s) => s.quoteId)
			if (ids.includes('seeds') || missing(ids).length) throw new ToolError(`Glance step quote ${noQuote(ids)}`)
			props.glance = glance
		}
		if (figure !== undefined) props.figure = figure
		if (summary !== undefined) props.summary = summary
		if (gaps) props.gaps = gaps

		const written = Object.keys(props)
		const at = Date.now()
		props.provenance = { ...p.provenance, ...Object.fromEntries(written.map((k) => [k, { model: ctx.model, at }])) }
		writer(txn).patchShape({ id: card.id, props, meta: agentMeta(ctx, { paperId }) })
		return { ok: true, written }
	})
	if (result.ok) changed(ctx, 'set_card', { paperId, fields: result.written })
	return result
}

// ---- add_quote

const addQuoteInput = {
	paperId: paperIdInput,
	text: z.string().min(1).max(600),
	source: z.string().max(40).optional(),
}

// A text fragment (#:~:text=) so the link scrolls to the quote; long quotes use start,end.
function quoteUrl(base: string, quote: string): string {
	if (!/^https?:\/\//.test(base)) return ''
	const enc = (s: string) => encodeURIComponent(s).replace(/-/g, '%2D')
	const words = quote.split(' ')
	const text = words.length > 10 ? `${enc(words.slice(0, 4).join(' '))},${enc(words.slice(-4).join(' '))}` : enc(quote)
	return `${base.split('#')[0]}#:~:text=${text}`
}

export async function addQuote(ctx: ToolContext, { paperId, text, source }: z.infer<z.ZodObject<typeof addQuoteInput>>) {
	const quote = normalise(text)
	// fail fast on a missing card before asking the papers MCP
	readRoom(ctx.boardId, (txn) => needCard(txn, paperId))
	let abstract: string
	let paperUrl: string
	try {
		const paper = await ctx.papers.getPaper(paperId)
		abstract = paper.abstract ?? ''
		paperUrl = paper.url ?? ''
	} catch (e) {
		throw new ToolError(`${(e as Error).message}, so the quote can't be checked; nothing was written`)
	}
	if (!abstract) {
		throw new ToolError(`The papers MCP has no abstract for ${paperId}, so quotes can't be checked; nothing was written`)
	}
	if (!normalise(abstract).includes(quote)) {
		throw new ToolError(`That text isn't in the abstract of ${paperId} word for word; nothing was written`)
	}
	const result = writeRoom(ctx.boardId, (txn) => {
		const card = needCard(txn, paperId)
		const locked = propsLocked(card)
		if (locked) return { quoteId: null, skipped: locked }
		const quotes = card.props.quotes
		const same = quotes.find((q) => normalise(q.text) === quote)
		if (same) return { quoteId: same.id }
		const n = Math.max(0, ...quotes.map((q) => Number(q.id.match(/^q(\d+)$/)?.[1] ?? 0)))
		const added: PaperQuote = {
			id: `q${n + 1}`,
			text: quote,
			source: source ?? 'abstract',
			verified: true,
			url: quoteUrl(card.props.url || paperUrl, quote),
		}
		writer(txn).patchShape({ id: card.id, props: { quotes: [...quotes, added] }, meta: agentMeta(ctx, { paperId }) })
		return { quoteId: added.id }
	})
	if (result.quoteId) changed(ctx, 'add_quote', { paperId, quoteId: result.quoteId })
	return result
}

// ---- link_papers

const linkPapersInput = {
	links: z
		.array(
			z.object({
				from: paperIdInput,
				to: paperIdInput,
				kind: z.enum(['cites', 'similar']),
				source: z.enum(['pubmed', 'openalex']).optional(),
			})
		)
		.min(1)
		.max(100),
}

const ARROW_PROPS = {
	kind: 'arc',
	elbowMidPoint: 0.5,
	dash: 'solid',
	size: 's',
	fill: 'none',
	color: 'grey',
	labelColor: 'black',
	bend: 0,
	start: { x: 0, y: 0 },
	end: { x: 0, y: 0 },
	arrowheadStart: 'none',
	arrowheadEnd: 'arrow',
	richText: toRichText(''),
	labelPosition: 0.5,
	font: 'draw',
	scale: 1,
} satisfies TLArrowShape['props']

const arrowEnd = (terminal: 'start' | 'end') => ({
	terminal,
	normalizedAnchor: { x: 0.5, y: 0.5 },
	isExact: false,
	isPrecise: false,
	snap: 'none' as const,
})

export function linkPapers(ctx: ToolContext, { links }: z.infer<z.ZodObject<typeof linkPapersInput>>) {
	const { removedLinks } = boardInfo(ctx.boardId)
	const result = writeRoom(ctx.boardId, (txn) => {
		const w = writer(txn)
		const deleted = deletedLinkIds(txn)
		const boxes = shapeBoxes(txn.values())
		const touched = new Set<string>()
		const linked: { from: string; to: string; kind: LinkKind }[] = []
		const skipped: { from: string; to: string; kind: LinkKind; reason: string }[] = []
		for (const link of links) {
			const { from, to, kind, source } = link
			const skip = (reason: string) => skipped.push({ ...link, reason })
			if (from === to) {
				skip('a paper can’t link to itself')
				continue
			}
			const a = findCard(txn, from)
			const b = findCard(txn, to)
			if (!a || !b) {
				skip(`no card for ${!a ? from : to}`)
				continue
			}
			// a citation either way already joins them, and says more
			const cited = [linkShapeId(from, to, 'cites'), linkShapeId(to, from, 'cites')]
			if (kind === 'similar' && cited.some((id) => isShape(txn.get(id as TLShapeId)))) {
				skip('already linked by a citation')
				continue
			}
			// a similar link has no direction, so either way round is the same link
			const pairs = kind === 'similar' ? [[from, to], [to, from]] : [[from, to]]
			const ids = pairs.map(([f, t]) => linkShapeId(f, t, kind) as TLShapeId)
			const existing = ids.map((id) => txn.get(id)).find(isShape)
			if (existing) {
				if (existing.meta.hiddenByHuman === true) skip('hidden by a person')
				else linked.push(link)
				continue
			}
			if (
				ids.some((id) => deleted.has(id)) ||
				removedLinks.some((r) => r.kind === kind && pairs.some(([f, t]) => r.from === f && r.to === t))
			) {
				skip('removed by a person')
				continue
			}
			const start = centre(boxes.get(a.id)!)
			const end = centre(boxes.get(b.id)!)
			const arrow = w.createShape({
				id: ids[0],
				type: 'arrow',
				x: start.x,
				y: start.y,
				props: {
					...ARROW_PROPS,
					end: { x: end.x - start.x, y: end.y - start.y },
					// a citation points from the citing paper; similarity has no direction
					...(kind === 'similar' ? { dash: 'dashed', arrowheadEnd: 'none' } : {}),
				},
				// who says they're linked: the citation's source, else PubMed for a citation and the agent for similarity
				meta: agentMeta(ctx, { kind, label: '', by: kind === 'cites' ? (source ?? 'pubmed') : 'agent', hiddenByHuman: false }),
			})
			for (const [terminal, card] of [['start', a], ['end', b]] as const) {
				w.createBinding({
					id: createBindingId(`${arrow.id.slice('shape:'.length)}-${terminal}`),
					type: 'arrow',
					fromId: arrow.id,
					toId: card.id,
					props: arrowEnd(terminal),
					meta: agentMeta(ctx),
				})
				touched.add(card.id)
			}
			linked.push(link)
		}
		return { linked, skipped, created: touched.size > 0 }
	})
	if (result.created) changed(ctx, 'link_papers', { linked: result.linked })
	return { linked: result.linked, skipped: result.skipped }
}

// ---- mark_working

const markWorkingInput = { paperIds: z.array(paperIdInput).min(1).max(50), on: z.boolean() }

export function markWorking(ctx: ToolContext, { paperIds, on }: z.infer<z.ZodObject<typeof markWorkingInput>>) {
	const result = writeRoom(ctx.boardId, (txn) => {
		const w = writer(txn)
		const skipped: { paperId: string; reason: string }[] = []
		for (const paperId of paperIds) {
			const card = findCard(txn, paperId)
			const reason = card ? propsLocked(card) : 'no card on this board'
			if (reason || !card) skipped.push({ paperId, reason: reason ?? '' })
			else w.patchShape({ id: card.id, props: { working: on }, meta: agentMeta(ctx, { paperId }) })
		}
		return { ok: true, skipped }
	})
	if (result.skipped.length < paperIds.length) changed(ctx, 'mark_working', { paperIds, on })
	return result
}

// ---- add_note

const addNoteInput = { text: z.string().min(1).max(1000), paperId: paperIdInput.optional() }

const NOTE_PROPS = {
	color: 'yellow',
	labelColor: 'black',
	size: 's',
	font: 'sans',
	fontSizeAdjustment: 1,
	align: 'start',
	verticalAlign: 'start',
	url: '',
	scale: 1,
	textLastEditedBy: null,
} satisfies Omit<TLNoteShape['props'], 'richText' | 'growY'>

// A browser sizes a note to its text only when someone edits it there, so estimate the growth
// here (size s: about 24 characters a line, 26 px a line) to keep long notes readable.
const noteGrowY = (text: string) =>
	Math.max(0, text.split('\n').reduce((lines, p) => lines + Math.max(1, Math.ceil(p.length / 24)), 0) * 26 + 32 - 200)

export function addNote(ctx: ToolContext, { text, paperId }: z.infer<z.ZodObject<typeof addNoteInput>>) {
	const result = writeRoom(ctx.boardId, (txn) => {
		const card = paperId ? needCard(txn, paperId) : undefined
		const records = [...txn.values()]
		const growY = noteGrowY(text)
		const size = { w: 200, h: 200 + growY }
		let at: Vec
		if (card) {
			// beside the card as drawn, on its right, if that's free; else the nearest free spot around it
			const box = shapeBoxes(records).get(card.id)!
			const right = { x: Math.round(box.x + box.w + 24), y: Math.round(box.y) }
			at = isFree(shapeBoxes(records).values(), { ...right, ...size }) ? right : placeNear(records, size, centre(box))
		} else {
			at = placeNear(records, size, anchorFor(records, txn, null, ctx.runId))
		}
		const w = writer(txn)
		const note = w.createShape({
			id: agentShapeId('note') as TLShapeId,
			type: 'note',
			...at,
			props: { ...NOTE_PROPS, growY, richText: toRichText(text) },
			meta: agentMeta(ctx, paperId ? { paperId } : {}),
		})
		if (card) {
			// the pin's offset is from the card's node, not from the card drawn around it
			w.createBinding({
				type: NOTE_PIN_TYPE,
				fromId: note.id,
				toId: card.id,
				props: { dx: at.x - card.x, dy: at.y - card.y },
				meta: agentMeta(ctx, { paperId: paperId! }),
			})
		}
		return { shapeId: note.id }
	})
	changed(ctx, 'add_note', { shapeId: result.shapeId, paperId: paperId ?? null })
	return result
}

// ---- the tool list the MCP registers

export function tool<S extends z.ZodRawShape>(
	name: string,
	description: string,
	input: S,
	run: (ctx: ToolContext, input: z.infer<z.ZodObject<S>>) => unknown
) {
	return { name, description, input, run: run as (ctx: ToolContext, input: unknown) => unknown }
}

export const canvasTools = [
	tool(
		'get_board',
		'Read the shared board as compact JSON: the research question and "Looking for" goals; every paper card ' +
			'(paperId, label, title, year, type, kind seed/kept/suggestion, status new/kept/contested/discarded, ' +
			'scores per goal, working, cluster, humanTouched, pinnedNotes); links between papers (from, to, kind, ' +
			'label, by, hidden); notes (text, author, pinnedTo); clusters (clusterId, label, labelGenerated, ' +
			'humanTouched); discarded paper IDs; and links people removed. ' +
			'At most 500 papers (seeds and kept first; `truncated` counts the rest), 1000 links and 200 notes. ' +
			'Changes nothing.',
		{},
		(ctx) => getBoard(ctx)
	),
	tool(
		'add_papers',
		'Add papers to the board as cards, or update the metadata of cards you added before; at most 50 per call. ' +
			'Each paper needs paperId (as the papers MCP gives it, e.g. pmid:34290406) and title. Optional: authors ' +
			'(display names, first author first), year, venue, url (http or https), type (as discovery reports it), ' +
			'peerReviewed, citedBy, retracted, foundBy (how it was found, e.g. "pubmed"); null means unknown and ' +
			'never overwrites a known value. kind (seed, kept or suggestion; default suggestion) applies to new cards ' +
			'only. Never give coordinates: put the most similar paper already on the board in `near` and the card is ' +
			'placed beside it without overlapping anything, inside that paper\'s cluster if it is in one (`near` may ' +
			'also be a clusterId from get_board); without `near` it goes on a ring around the first card of this ' +
			'turn. New cards start with status new and the "Agent is reading…" ring on (turn it off with mark_working). ' +
			'Skipped with a reason: retracted papers, seeds already on the board, and cards a person made, moved ' +
			'or edited. Returns {added, updated, skipped: [{paperId, reason}]} with paper IDs.',
		addPapersInput,
		addPapers
	),
	tool(
		'set_scores',
		'Set how well one paper fits each of the board\'s "Looking for" goals (`goals` in get_board); the node ' +
			'colour and the ranked list follow it. scores maps a goal ID to {score 0 to 1, fit low/medium/high, why: ' +
			'the ranked list\'s one line, at most 200 characters}. Goals left out keep their scores. Returns {ok}; ' +
			'{ok: false, skipped: reason} if a person made or edited the card. Errors if the paper has no card or a ' +
			'goal isn\'t one of the board\'s.',
		setScoresInput,
		setScores
	),
	tool(
		'set_card',
		'Fill in what an opened paper shows, any subset of fields per call; the card fills in live, section by ' +
			'section. oneLine: "Why it matters to you", one or two sentences (at most 400 characters) for the ' +
			'board\'s question. claims: phrases of oneLine to underline (each must appear in it word for word), ' +
			'each with evidence: quote IDs from add_quote, or "seeds" when it compares with the board\'s seeds. ' +
			'glance: "The paper at a glance", 3 or 4 steps such as Samples, Method, Readout, Finding: {label, short ' +
			'text, quoteId of the quote it comes from or null, relation to the seeds: same, adds, other, or null for ' +
			'no mark}. figure: a real figure from the paper, never a generated image: {imageUrl (https), label like ' +
			'"Fig. 3", caption, captionByAi: true if you wrote the caption}, or null to remove it. summary: at most ' +
			'1500 characters. gaps: what you couldn\'t check, at most 8. Add quotes first: every quote ID you cite ' +
			'must already be on the card. Changing oneLine drops claims whose text is no longer in it. Returns {ok, ' +
			'written}; {ok: false, skipped: reason} if a person made or edited the card.',
		setCardInput,
		setCard
	),
	tool(
		'add_quote',
		'Add a quote to a paper\'s card: text copied word for word from the paper\'s abstract (whitespace may ' +
			'differ), at most 600 characters. It is checked against the abstract from the papers MCP; if it isn\'t ' +
			'there, or the papers MCP can\'t be reached, you get an error and nothing is written. Full-text quotes ' +
			'aren\'t supported yet. source defaults to "abstract". Returns {quoteId} to cite in set_card\'s claims and ' +
			'glance; the same text again returns the same ID. {quoteId: null, skipped: reason} if a person made or ' +
			'edited the card.',
		addQuoteInput,
		addQuote
	),
	tool(
		'link_papers',
		'Link pairs of papers on the board with an arrow; at most 100 links per call, and both papers need cards. ' +
			'kind: cites (a citation: `from` cites `to`) or similar (your judgement that the two are closely ' +
			'related; direction doesn\'t matter). source (optional): where a citation comes from, pubmed (the ' +
			'default for cites) or openalex; the arrow records it, and records every similar link as the agent\'s. ' +
			'Linking a pair again is a no-op. Skipped with a reason: a paper linked to itself, a missing ' +
			'card, a similar link between papers a citation already joins, and links a person removed or hid; ' +
			'never try to recreate those. Links can\'t be labelled or removed through this server. Returns ' +
			'{linked, skipped}.',
		linkPapersInput,
		linkPapers
	),
	tool(
		'mark_working',
		'Turn the "Agent is reading…" ring on papers\' nodes on (on: true) when you start reading them and off ' +
			'(on: false) when their cards are filled in; at most 50 paper IDs per call. Returns {ok, skipped} with ' +
			'cards that are missing or that a person made or edited.',
		markWorkingInput,
		markWorking
	),
	tool(
		'add_note',
		'Add a sticky note to the board, written as the agent: a few sentences, at most 1000 characters. With ' +
			'paperId it is pinned beside that paper\'s card, moves with it and shows in the paper\'s notes; ' +
			'without, it goes near the first card of this turn. Returns {shapeId}. Notes can\'t be edited or ' +
			'removed through this server.',
		addNoteInput,
		addNote
	),
]
