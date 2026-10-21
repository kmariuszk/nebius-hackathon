// The cluster tools against a real TLSocketRoom on a temp data dir: node --test server/clusterTools.test.ts
import type { TLBinding, TLFrameShape, TLRecord, TLShape } from '@tldraw/tlschema'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { clusterShapeId, paperShapeId } from '../shared/ids.ts'
import { CARD_SIZE, type PaperCardShape } from '../shared/shapes.ts'
import { addNote, addPapers, getBoard, ToolError, type ToolContext } from './canvasTools.ts'
import { applyClusters, labelCluster } from './clusterTools.ts'
import { centre, isFree, MARGIN, shapeBoxes } from './layout.ts'
import type { ClusterResult, PapersClient } from './papersClient.ts'
import { closeAllRooms, patchShapes, putShapes, readRoom, setRoomsDir } from './rooms.ts'

const dir = mkdtempSync(join(tmpdir(), 'cluster-tools-'))
setRoomsDir(dir)
after(() => {
	closeAllRooms()
	rmSync(dir, { recursive: true, force: true })
})

let clusters: ClusterResult = { clusters: [], similarities: [] }
let clusterCalls: string[][] = []
const papers: PapersClient = {
	url: 'http://papers.test/mcp',
	close: async () => {},
	getPaper: async (paperId) => ({ paperId, title: 'T', abstract: 'A', url: null }),
	hasTool: async (name) => name === 'cluster_papers',
	async clusterPapers(paperIds) {
		clusterCalls.push(paperIds)
		if (paperIds.includes('down')) throw new Error('The papers MCP at http://papers.test/mcp is unreachable (ECONNREFUSED)')
		return clusters
	},
}

let boards = 0
const newCtx = (): ToolContext => ({
	boardId: `clusters${++boards}`,
	onBehalfOf: 'm_ana',
	runId: 'run_0123456789ab',
	model: null,
	papers,
})

const all = (ctx: ToolContext) => readRoom(ctx.boardId, (txn) => [...txn.values()]) as TLRecord[]
const get = <T extends TLShape>(ctx: ToolContext, id: string) => readRoom(ctx.boardId, (txn) => txn.get(id as never)) as T
const card = (ctx: ToolContext, paperId: string) => get<PaperCardShape>(ctx, paperShapeId(paperId))
const frame = (ctx: ToolContext, clusterId: string) => get<TLFrameShape>(ctx, clusterShapeId(clusterId))
const paper = (paperId: string, extra = {}) => ({ paperId, title: `Paper ${paperId}`, ...extra })
const rejects = (fn: () => unknown, pattern: RegExp) =>
	assert.rejects(async () => fn(), (e: Error) => e instanceof ToolError && pattern.test(e.message))

// every box on the page, and every box inside each frame, keeps the layout margin from its neighbours
function assertNoOverlaps(ctx: ToolContext) {
	const records = all(ctx)
	const boxes = shapeBoxes(records)
	const byParent = new Map<string, string[]>()
	for (const r of records) {
		if (r.typeName !== 'shape' || !boxes.has(r.id)) continue
		byParent.set(r.parentId, [...(byParent.get(r.parentId) ?? []), r.id])
	}
	for (const ids of byParent.values()) {
		ids.forEach((id, i) => {
			const others = ids.slice(0, i).map((o) => boxes.get(o)!)
			assert.ok(isFree(others, boxes.get(id)!), `${id} overlaps a sibling`)
		})
	}
}

test('apply_clusters puts the agent’s papers into named frames and leaves people’s papers alone', async () => {
	const ctx = newCtx()
	addPapers(ctx, { papers: ['a', 'b', 'c', 'd', 'e', 'moved'].map((id) => paper(id)) })
	putShapes(ctx.boardId, [
		{ id: paperShapeId('mine'), type: 'paper-card', x: -400, y: 0, props: { ...card(ctx, 'a').props, paperId: 'mine' }, meta: { author: 'm_ben' } },
	])
	patchShapes(ctx.boardId, [{ id: card(ctx, 'moved').id, x: 900, y: 900, meta: { pinnedByHuman: true } }])
	const before = { mine: card(ctx, 'mine'), moved: card(ctx, 'moved') }
	clusters = {
		clusters: [
			{ clusterId: 'c1', paperIds: ['a', 'b', 'c', 'mine'], label: 'T-cell states' },
			{ clusterId: 'c2', paperIds: ['d', 'e', 'moved', 'not-here'], label: null },
		],
		similarities: [{ a: 'c', b: 'b', similarity: 0.9 }],
	}

	const result = await applyClusters(ctx, {})
	assert.deepEqual(clusterCalls.at(-1)?.sort(), ['a', 'b', 'c', 'd', 'e', 'mine', 'moved'])
	assert.deepEqual(result.clusters, [
		{ clusterId: 'c1', label: 'T-cell states', paperIds: ['a', 'b', 'c'] },
		{ clusterId: 'c2', label: '', paperIds: ['d', 'e'] },
	])
	assert.deepEqual(result.skipped, [
		{ paperId: 'mine', reason: 'made by a person' },
		{ paperId: 'moved', reason: 'moved by a person' },
		{ paperId: 'not-here', reason: 'no card on this board' },
	])

	const c1 = frame(ctx, 'c1')
	assert.equal(c1.type, 'frame')
	assert.equal(c1.props.name, 'T-cell states')
	assert.deepEqual(c1.meta, {
		createdBy: 'agent',
		onBehalfOf: 'm_ana',
		runId: 'run_0123456789ab',
		clusterId: 'c1',
		labelGenerated: true,
		renamedByHuman: false,
	})
	assert.equal(frame(ctx, 'c2').meta.labelGenerated, false)
	for (const id of ['a', 'b', 'c']) assert.equal(card(ctx, id).parentId, c1.id)
	// the most similar papers come first in the grid
	assert.ok(card(ctx, 'b').x < card(ctx, 'a').x || card(ctx, 'b').y < card(ctx, 'a').y)
	// people's papers keep their place
	assert.deepEqual(card(ctx, 'mine'), before.mine)
	assert.deepEqual(card(ctx, 'moved'), before.moved)
	// frames sit under everything else on the page, so links stay visible
	const pageShapes = all(ctx).filter((r): r is TLShape => r.typeName === 'shape' && r.parentId === c1.parentId)
	const frames = pageShapes.filter((s) => s.type === 'frame').map((s) => s.index)
	const rest = pageShapes.filter((s) => s.type !== 'frame').map((s) => s.index)
	assert.ok(frames.every((f) => rest.every((r) => f < r)))
	assertNoOverlaps(ctx)

	const board = getBoard(ctx)
	assert.deepEqual(board.clusters, [
		{ clusterId: 'c1', label: 'T-cell states', labelGenerated: true, humanTouched: false },
		{ clusterId: 'c2', label: '', labelGenerated: false, humanTouched: false },
	])
	assert.equal(board.papers.find((p) => p.paperId === 'a')?.cluster, 'c1')
	assert.equal(board.papers.find((p) => p.paperId === 'mine')?.cluster, null)

	// running it again moves nothing
	const cards = ['a', 'b', 'c', 'd', 'e'].map((id) => card(ctx, id))
	const again = await applyClusters(ctx, { paperIds: ['a', 'b', 'c', 'd', 'e'] })
	assert.deepEqual(again.clusters, result.clusters)
	assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map((id) => card(ctx, id)), cards)
})

test('apply_clusters fits nine cards in a frame: none overlap as drawn and each is inside the frame’s inner box', async () => {
	const ctx = newCtx()
	const ids = Array.from({ length: 9 }, (_, i) => `p${i}`)
	addPapers(ctx, { papers: ids.map((id) => paper(id)) })
	clusters = { clusters: [{ clusterId: 'c9', paperIds: ids, label: 'Nine' }], similarities: [] }
	await applyClusters(ctx, {})
	const f = frame(ctx, 'c9')
	const inner = { x: f.x + MARGIN, y: f.y + MARGIN, w: f.props.w - 2 * MARGIN, h: f.props.h - 2 * MARGIN }
	// what the browser draws: a CARD_SIZE card centred on each node
	const drawn = ids.map((id) => {
		const c = card(ctx, id)
		assert.equal(c.parentId, f.id)
		const [x, y] = [f.x + c.x + c.props.w / 2 - CARD_SIZE.w / 2, f.y + c.y + c.props.h / 2 - CARD_SIZE.h / 2]
		return { x, y, w: CARD_SIZE.w, h: CARD_SIZE.h }
	})
	for (const b of drawn) {
		assert.ok(b.x >= inner.x && b.y >= inner.y && b.x + b.w <= inner.x + inner.w && b.y + b.h <= inner.y + inner.h)
	}
	drawn.forEach((b, i) => assert.ok(isFree(drawn.slice(0, i), b), `${ids[i]} overlaps another card`))
	assertNoOverlaps(ctx)
})

test('add_papers near a clustered paper, or near a cluster, joins it; a full frame grows unless a person edited it', async () => {
	const ctx = newCtx()
	addPapers(ctx, { papers: [paper('a'), paper('b')] })
	clusters = { clusters: [{ clusterId: 'c1', paperIds: ['a', 'b'], label: 'Atlas' }], similarities: [] }
	await applyClusters(ctx, {})
	const c1 = frame(ctx, 'c1')

	addPapers(ctx, { papers: [paper('n1', { near: 'a' }), paper('n2', { near: 'c1' })] })
	assert.equal(card(ctx, 'n1').parentId, c1.id)
	assert.equal(card(ctx, 'n2').parentId, c1.id)

	// many more: the agent's frame grows to take them all
	addPapers(ctx, { papers: Array.from({ length: 8 }, (_, i) => paper(`m${i}`, { near: 'a' })) })
	for (let i = 0; i < 8; i++) assert.equal(card(ctx, `m${i}`).parentId, c1.id, `m${i}`)
	assert.ok(frame(ctx, 'c1').props.h > c1.props.h)
	assert.equal(frame(ctx, 'c1').x, c1.x)
	assert.equal(frame(ctx, 'c1').y, c1.y)
	assertNoOverlaps(ctx)

	// once a person resized it, it keeps its size and new papers go beside it on the page
	patchShapes(ctx.boardId, [{ id: c1.id, meta: { editedByHuman: true } }])
	const size = frame(ctx, 'c1').props
	addPapers(ctx, { papers: Array.from({ length: 6 }, (_, i) => paper(`o${i}`, { near: 'a' })) })
	assert.deepEqual(frame(ctx, 'c1').props, size)
	assert.ok(['o0', 'o1', 'o2', 'o3', 'o4', 'o5'].some((id) => card(ctx, id).parentId !== c1.id))
	assertNoOverlaps(ctx)
})

test('notes pinned to a clustered paper go beside it, outside the frame; a person’s note keeps its paper put', async () => {
	const ctx = newCtx()
	addPapers(ctx, { papers: ['a', 'b', 'c'].map((id) => paper(id)) })
	const { shapeId } = addNote(ctx, { text: 'Read the methods', paperId: 'a' })
	const people = { ...card(ctx, 'c') }
	// 24 px right of the drawn card
	const dx = people.props.w / 2 + CARD_SIZE.w / 2 + 24
	putShapes(ctx.boardId, [
		{ id: 'shape:their-note', type: 'note', x: people.x + dx, y: people.y, props: get<TLShape>(ctx, shapeId).props, meta: { author: 'm_ben' } },
		{ typeName: 'binding', id: 'binding:their-pin', type: 'note-pin', fromId: 'shape:their-note', toId: people.id, props: { dx, dy: 0 }, meta: {} },
	])
	clusters = { clusters: [{ clusterId: 'c1', paperIds: ['a', 'b', 'c'], label: 'Methods' }], similarities: [] }

	const result = await applyClusters(ctx, {})
	assert.deepEqual(result.skipped, [{ paperId: 'c', reason: 'a person’s note is pinned to it' }])
	assert.deepEqual(card(ctx, 'c'), people)

	const boxes = shapeBoxes(all(ctx))
	const note = boxes.get(shapeId)!
	const frameBox = boxes.get(clusterShapeId('c1'))!
	assert.ok(isFree([frameBox], note), 'the note sits outside the frame')
	const pin = all(ctx).find((r) => r.typeName === 'binding' && r.type === 'note-pin' && r.fromId === shapeId) as TLBinding<'note-pin'>
	// the pin's offset is from the node's page position, not from the card drawn around it
	const a = card(ctx, 'a')
	assert.equal(a.parentId, clusterShapeId('c1'))
	assert.deepEqual({ dx: note.x - (frameBox.x + a.x), dy: note.y - (frameBox.y + a.y) }, pin.props)
	const cardBox = boxes.get(a.id)!
	const [n, c] = [centre(note), centre(cardBox)]
	assert.ok(Math.hypot(n.x - c.x, n.y - c.y) < 400, 'the note stays beside its paper')
	assertNoOverlaps(ctx)
})

test('label_cluster renames the agent’s clusters only', async () => {
	const ctx = newCtx()
	addPapers(ctx, { papers: [paper('a'), paper('b'), paper('c'), paper('d')] })
	clusters = {
		clusters: [
			{ clusterId: 'c1', paperIds: ['a', 'b'], label: null },
			{ clusterId: 'c2', paperIds: ['c', 'd'], label: 'Old' },
		],
		similarities: [],
	}
	await applyClusters(ctx, {})
	assert.deepEqual(labelCluster(ctx, { clusterId: 'c1', label: 'Checkpoint response' }), { ok: true })
	assert.equal(frame(ctx, 'c1').props.name, 'Checkpoint response')
	assert.equal(frame(ctx, 'c1').meta.labelGenerated, true)

	patchShapes(ctx.boardId, [{ id: frame(ctx, 'c2').id, props: { name: 'Mine' }, meta: { renamedByHuman: true } }])
	assert.deepEqual(labelCluster(ctx, { clusterId: 'c2', label: 'New' }), { ok: false, skipped: 'renamed by a person' })
	assert.equal(frame(ctx, 'c2').props.name, 'Mine')
	// a re-run doesn't rename it either
	clusters.clusters[1].label = 'Newer'
	await applyClusters(ctx, {})
	assert.equal(frame(ctx, 'c2').props.name, 'Mine')

	await rejects(() => labelCluster(ctx, { clusterId: 'nope', label: 'X' }), /No cluster nope/)
})

// One real cluster_papers result (discovery/tests/test_clusters.py's three groups, k=3, Lightning failing for one)
const REAL = {
	clusters: [
		{ clusterId: 'c-pmid_101', paperIds: ['pmid:101', 'pmid:100', 'pmid:102', 'pmid:103'], label: 'Tumour ecosystem' },
		{ clusterId: 'c-pmid_200', paperIds: ['pmid:200', 'pmid:202', 'pmid:201', 'pmid:203'], label: 'T cell exhaustion' },
		{ clusterId: 'c-pmid_300', paperIds: ['pmid:300', 'pmid:303', 'pmid:302', 'pmid:301'], label: null },
	],
	similarities: [
		{ a: 'pmid:100', b: 'pmid:101', similarity: 0.995 }, { a: 'pmid:100', b: 'pmid:103', similarity: 0.988 },
		{ a: 'pmid:100', b: 'pmid:102', similarity: 0.986 }, { a: 'pmid:200', b: 'pmid:202', similarity: 0.995 },
		{ a: 'pmid:200', b: 'pmid:201', similarity: 0.991 }, { a: 'pmid:200', b: 'pmid:203', similarity: 0.989 },
		{ a: 'pmid:300', b: 'pmid:303', similarity: 0.988 }, { a: 'pmid:300', b: 'pmid:302', similarity: 0.988 },
		{ a: 'pmid:300', b: 'pmid:301', similarity: 0.988 }, { a: 'pmid:101', b: 'pmid:102', similarity: 0.994 },
		{ a: 'pmid:101', b: 'pmid:103', similarity: 0.982 }, { a: 'pmid:201', b: 'pmid:202', similarity: 0.989 },
		{ a: 'pmid:201', b: 'pmid:203', similarity: 0.969 }, { a: 'pmid:301', b: 'pmid:302', similarity: 0.983 },
		{ a: 'pmid:301', b: 'pmid:303', similarity: 0.967 }, { a: 'pmid:102', b: 'pmid:103', similarity: 0.979 },
		{ a: 'pmid:202', b: 'pmid:203', similarity: 0.984 }, { a: 'pmid:302', b: 'pmid:303', similarity: 0.985 },
	],
	skipped: ["paper isbn:1: Unknown paper ID 'isbn:1': expected one of doi:…, pmid:…, pmcid:…, arxiv:…, openalex:…, s2:…"],
}

test('apply_clusters takes cluster_papers’ real result, and a second run with one more paper reuses its frames', async () => {
	const ctx = newCtx()
	addPapers(ctx, { papers: REAL.clusters.flatMap((c) => c.paperIds).map((id) => paper(id)) })
	clusters = REAL as ClusterResult

	const result = await applyClusters(ctx, {})
	assert.deepEqual(
		result.clusters,
		REAL.clusters.map(({ clusterId, paperIds, label }) => ({ clusterId, label: label ?? '', paperIds }))
	)
	assert.deepEqual(result.skipped, [])
	assert.equal(frame(ctx, 'c-pmid_101').id, 'shape:cluster-c-pmid_101')
	assert.equal(frame(ctx, 'c-pmid_300').meta.labelGenerated, false)
	assertNoOverlaps(ctx)

	// the next call, with one more paper close to a cluster, keeps the cluster IDs
	addPapers(ctx, { papers: [paper('pmid:250')] })
	clusters = {
		...REAL,
		clusters: REAL.clusters.map((c) => (c.clusterId === 'c-pmid_200' ? { ...c, paperIds: [...c.paperIds, 'pmid:250'] } : c)),
	} as ClusterResult
	const frames = all(ctx).filter((r) => r.typeName === 'shape' && r.type === 'frame')
	const again = await applyClusters(ctx, {})
	assert.deepEqual(again.clusters.map((c) => c.clusterId), ['c-pmid_101', 'c-pmid_200', 'c-pmid_300'])
	assert.deepEqual(all(ctx).filter((r) => r.typeName === 'shape' && r.type === 'frame').map((f) => f.id), frames.map((f) => f.id))
	assertNoOverlaps(ctx)
})

test('apply_clusters writes nothing when the papers MCP fails, and needs two papers', async () => {
	const ctx = newCtx()
	addPapers(ctx, { papers: [paper('a'), paper('down')] })
	const before = all(ctx)
	await rejects(() => applyClusters(ctx, {}), /unreachable.*nothing was written/)
	assert.deepEqual(all(ctx), before)
	const empty = newCtx()
	await rejects(() => applyClusters(empty, {}), /at least two papers/)
})
