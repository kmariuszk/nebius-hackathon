import type { TLFrameShape, TLShapeId } from '@tldraw/tlschema'
import { getIndexBelow, type IndexKey } from '@tldraw/utils'
import { z } from 'zod'
import { NOTE_PIN_TYPE, type NotePinBinding } from '../shared/bindings.ts'
import { clusterShapeId } from '../shared/ids.ts'
import { isAgentShape, isHumanTouched } from '../shared/meta.ts'
import type { PaperCardShape } from '../shared/shapes.ts'
import {
	agentMeta,
	changed,
	findCard,
	findClusterFrame,
	isCard,
	isShape,
	paperIdInput,
	propsLocked,
	spotInFrame,
	tool,
	ToolError,
	type ToolContext,
} from './canvasTools.ts'
import { centre, placeNear, shapeBoxes } from './layout.ts'
import type { ClusterResult } from './papersClient.ts'
import { readRoom, schema, writeRoom, writer, type Txn } from './rooms.ts'

// The canvas MCP's cluster tools (T02 phase 2). Clusters come from data, not the agent's
// judgement (Concept, Clustering and layout): apply_clusters asks the papers MCP's cluster_papers
// itself, so the canvas MCP lists these tools only while the papers MCP lists cluster_papers (I5).
// A cluster is a built-in frame with meta.clusterId, labelGenerated and renamedByHuman (T01).

// a grid cell per card in a new frame: the node, plus its label hanging below it
const CELL = { w: 150, h: 130 }
const LABEL_H = 34
const PAD = 16

const applyClustersInput = {
	paperIds: z.array(paperIdInput).min(2).max(500).optional(),
}

type Skip = { paperId?: string; clusterId?: string; reason: string }

// Most similar to the rest of its cluster first, so the grid starts with the cluster's core
function bySimilarity(cards: PaperCardShape[], similarities: ClusterResult['similarities']) {
	const ids = new Set(cards.map((c) => c.props.paperId))
	const total = new Map<string, number>()
	for (const { a, b, similarity } of similarities) {
		if (!ids.has(a) || !ids.has(b)) continue
		total.set(a, (total.get(a) ?? 0) + similarity)
		total.set(b, (total.get(b) ?? 0) + similarity)
	}
	return cards
		.map((card, i) => ({ card, i, s: total.get(card.props.paperId) ?? 0 }))
		.sort((x, y) => y.s - x.s || x.i - y.i)
		.map((x) => x.card)
}

const pinsTo = (txn: Txn, cardId: string) =>
	[...txn.values()].filter((r): r is NotePinBinding => r.typeName === 'binding' && r.type === NOTE_PIN_TYPE && r.toId === cardId)

// Why a card can't move into a cluster, or null. Its pinned notes move with it (browsers keep
// them at their offset), so a note a person made, moved or edited keeps the card where it is.
function stuck(txn: Txn, card: PaperCardShape): string | null {
	if (!isAgentShape(card.meta)) return 'made by a person'
	if (card.meta.pinnedByHuman === true) return 'moved by a person'
	for (const pin of pinsTo(txn, card.id)) {
		const note = txn.get(pin.fromId)
		if (!isShape(note) || !isAgentShape(note.meta) || isHumanTouched(note.meta)) return 'a person’s note is pinned to it'
	}
	return null
}

// A moved card's pinned notes would follow it at their old offset, onto its cluster's other
// papers; put each beside the card again instead (outside the frame, which is in the way) and
// update its pin, so every browser keeps it there.
function replaceNotes(txn: Txn, card: TLShapeId) {
	const w = writer(txn)
	for (const pin of pinsTo(txn, card)) {
		const records = [...txn.values()].filter((r) => r.id !== pin.fromId)
		const cardBox = shapeBoxes(records).get(card)!
		const { w: nw, h: nh } = shapeBoxes([txn.get(pin.fromId)!]).get(pin.fromId)!
		const at = placeNear(records, { w: nw, h: nh }, centre(cardBox))
		w.patchShape({ id: pin.fromId, parentId: w.pageId, ...at })
		txn.set(pin.id, schema.types.binding.validate({ ...pin, props: { dx: at.x - cardBox.x, dy: at.y - cardBox.y } }))
	}
}

// A new frame sized for its cards, centred where they were, under every other shape on the page
// so links stay visible above it. The cards move into a grid inside it.
function newClusterFrame(txn: Txn, ctx: ToolContext, clusterId: string, label: string | null, cards: PaperCardShape[]) {
	const moving = new Set<string>(cards.map((c) => c.id))
	const records = [...txn.values()]
	const boxes = shapeBoxes(records)
	const centres = cards.map((c) => centre(boxes.get(c.id)!))
	const anchor = {
		x: centres.reduce((sum, p) => sum + p.x, 0) / centres.length,
		y: centres.reduce((sum, p) => sum + p.y, 0) / centres.length,
	}
	const cols = Math.ceil(Math.sqrt(cards.length))
	const rows = Math.ceil(cards.length / cols)
	const size = { w: cols * CELL.w + 2 * PAD, h: rows * CELL.h + 2 * PAD }
	const at = placeNear(
		records.filter((r) => !moving.has(r.id)),
		size,
		anchor
	)
	const w = writer(txn)
	const lowest = records.reduce<IndexKey | null>(
		(min, r) => (isShape(r) && r.parentId === w.pageId && (!min || r.index < min) ? r.index : min),
		null
	)
	const frame = w.createShape({
		id: clusterShapeId(clusterId) as TLShapeId,
		type: 'frame',
		...at,
		props: { w: size.w, h: size.h, name: label ?? '', color: 'black' },
		meta: agentMeta(ctx, { clusterId, labelGenerated: label !== null, renamedByHuman: false }),
	})
	w.patchShape({ id: frame.id, index: getIndexBelow(lowest) })
	cards.forEach((card, i) => {
		const [col, row] = [i % cols, Math.floor(i / cols)]
		w.patchShape({
			id: card.id,
			parentId: frame.id,
			x: Math.round(PAD + col * CELL.w + (CELL.w - card.props.w) / 2),
			y: Math.round(PAD + row * CELL.h + (CELL.h - LABEL_H - card.props.h) / 2),
		})
	})
	for (const card of cards) replaceNotes(txn, card.id)
	return frame as TLFrameShape
}

export async function applyClusters(ctx: ToolContext, { paperIds }: z.infer<z.ZodObject<typeof applyClustersInput>>) {
	const ids =
		paperIds ??
		readRoom(ctx.boardId, (txn) => [...txn.values()].filter(isCard).map((c) => c.props.paperId)).slice(0, 500)
	if (ids.length < 2) throw new ToolError('Clustering needs at least two papers on the board')
	if (!ctx.papers.clusterPapers) throw new ToolError('The papers MCP has no cluster_papers tool')
	let found: ClusterResult
	try {
		found = await ctx.papers.clusterPapers(ids)
	} catch (e) {
		throw new ToolError(`${(e as Error).message}; nothing was written`)
	}

	const result = writeRoom(ctx.boardId, (txn) => {
		const w = writer(txn)
		const clusters: { clusterId: string; label: string; paperIds: string[] }[] = []
		const skipped: Skip[] = []
		for (const { clusterId, paperIds, label } of found.clusters) {
			let frame = findClusterFrame(txn, clusterId)
			const cards: PaperCardShape[] = []
			for (const paperId of paperIds) {
				const card = findCard(txn, paperId)
				if (card && card.parentId === frame?.id) continue
				const reason = card ? stuck(txn, card) : 'no card on this board'
				if (reason || !card) skipped.push({ paperId, reason: reason ?? '' })
				else cards.push(card)
			}
			const moving = bySimilarity(cards, found.similarities)
			if (!frame) {
				if (!moving.length) {
					skipped.push({ clusterId, reason: 'none of its papers can be moved into it' })
					continue
				}
				frame = newClusterFrame(txn, ctx, clusterId, label, moving)
			} else {
				// an existing cluster keeps its place and size unless it is full; its papers stay put
				const anchor = centre(shapeBoxes(txn.values()).get(frame.id)!)
				for (const card of moving) {
					const spot = spotInFrame(txn, frame.id, { w: card.props.w, h: card.props.h }, anchor)
					if (!spot) skipped.push({ paperId: card.props.paperId, reason: 'no room left in its cluster' })
					else {
						w.patchShape({ id: card.id, parentId: frame.id, ...spot })
						replaceNotes(txn, card.id)
					}
				}
				if (label && !propsLocked(frame) && frame.meta.renamedByHuman !== true && frame.props.name !== label) {
					w.patchShape({ id: frame.id, props: { name: label }, meta: { labelGenerated: true } })
				}
				frame = findClusterFrame(txn, clusterId)!
			}
			// the cluster's papers now in its frame, in discovery's order, then any others already there
			const inside = new Set<string>()
			for (const r of txn.values()) if (isCard(r) && r.parentId === frame.id) inside.add(r.props.paperId)
			const listed = paperIds.filter((id) => inside.has(id))
			clusters.push({ clusterId, label: frame.props.name, paperIds: [...new Set([...listed, ...inside])] })
		}
		return { clusters, skipped }
	})
	if (result.clusters.length) {
		changed(ctx, 'apply_clusters', { clusters: result.clusters.map((c) => c.clusterId) })
	}
	return result
}

const labelClusterInput = {
	clusterId: z.string().min(1).max(100),
	label: z.string().min(1).max(60),
}

export function labelCluster(ctx: ToolContext, { clusterId, label }: z.infer<z.ZodObject<typeof labelClusterInput>>) {
	const result = writeRoom(ctx.boardId, (txn) => {
		const frame = findClusterFrame(txn, clusterId)
		if (!frame) throw new ToolError(`No cluster ${clusterId} on this board (clusters are in get_board)`)
		const locked = frame.meta.renamedByHuman === true ? 'renamed by a person' : propsLocked(frame)
		if (locked) return { ok: false, skipped: locked }
		writer(txn).patchShape({ id: frame.id, props: { name: label }, meta: { labelGenerated: true } })
		return { ok: true }
	})
	if (result.ok) changed(ctx, 'label_cluster', { clusterId, label })
	return result
}

/** Listed by the canvas MCP only while the papers MCP lists cluster_papers (I5). */
export const clusterTools = [
	tool(
		'apply_clusters',
		'Group the board\'s papers into clusters of similar papers, as the papers MCP\'s cluster_papers finds them, ' +
			'so close papers sit together. Give paperIds to cluster only those (2 to 500); by default every paper on ' +
			'the board. Each cluster becomes a frame named by discovery; papers you added move into a grid inside a new ' +
			'frame, or into free space in a cluster already on the board, and their notes stay beside them. Papers ' +
			'people added or moved, or with a person\'s note pinned to them, stay where they are and come back in ' +
			'skipped, as do papers with no card. Run it after the ' +
			'first search, not after every paper: from then on add_papers with `near` puts new papers inside their ' +
			'neighbour\'s cluster. Returns {clusters: [{clusterId, label, paperIds}], skipped: [{paperId or clusterId, ' +
			'reason}]}; errors, writing nothing, if the papers MCP can\'t cluster them.',
		applyClustersInput,
		applyClusters
	),
	tool(
		'label_cluster',
		'Rename a cluster (clusterId from get_board or apply_clusters) with a short label, at most 60 characters, ' +
			'shown as generated by the agent. Returns {ok}; {ok: false, skipped: reason} if a person made, renamed or ' +
			'edited the cluster, and an error if there is no such cluster.',
		labelClusterInput,
		labelCluster
	),
]
