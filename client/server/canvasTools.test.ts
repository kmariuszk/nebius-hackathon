// The canvas MCP's tools against a real TLSocketRoom on a temp data dir: node --test server/canvasTools.test.ts
import type { TLBinding, TLRecord, TLShape, TLShapeId } from '@tldraw/tlschema'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { linkShapeId, paperShapeId } from '../shared/ids.ts'
import { CARD_SIZE, type PaperCardShape } from '../shared/shapes.ts'
import {
	addNote,
	addPapers,
	addQuote,
	getBoard,
	linkPapers,
	markWorking,
	setCard,
	setScores,
	ToolError,
	type ToolContext,
} from './canvasTools.ts'
import { isFree, shapeBoxes } from './layout.ts'
import type { PapersClient } from './papersClient.ts'
import { closeBoardDb, setBoardDbPath } from './boardDb.ts'
import { closeAllRooms, patchShapes, putShapes, readRoom, setRoomsDir, writeRoom } from './rooms.ts'

const dir = mkdtempSync(join(tmpdir(), 'canvas-tools-'))
setRoomsDir(dir)
setBoardDbPath(join(dir, 'board.db'))
after(async () => {
	// let the storage's throttled tombstone pruning (1 s after a delete) run before its database closes
	await new Promise((resolve) => setTimeout(resolve, 1100))
	closeAllRooms()
	closeBoardDb()
	rmSync(dir, { recursive: true, force: true })
})

const ABSTRACT = 'We profiled 4,645 single cells from 19 melanomas.\n  Malignant cells   showed\ntwo transcriptional programs.'
let papersDown = false
const papers: PapersClient = {
	url: 'http://papers.test/mcp',
	close: async () => {},
	async getPaper(paperId) {
		if (papersDown) throw new Error('The papers MCP at http://papers.test/mcp is unreachable (ECONNREFUSED)')
		return { paperId, title: 'Melanoma atlas', abstract: ABSTRACT, url: 'https://pubmed.ncbi.nlm.nih.gov/27124452/' }
	},
}

let boards = 0
const newCtx = (over: Partial<ToolContext> = {}): ToolContext => ({
	boardId: `board${++boards}`,
	onBehalfOf: 'm_ana',
	runId: 'run_0123456789ab',
	model: 'nvidia/Nemotron-3.5-Super-VL',
	papers,
	...over,
})

const all = (ctx: ToolContext) => readRoom(ctx.boardId, (txn) => [...txn.values()]) as TLRecord[]
const card = (ctx: ToolContext, paperId: string) =>
	readRoom(ctx.boardId, (txn) => txn.get(paperShapeId(paperId))) as PaperCardShape
const paper = (paperId: string, extra = {}) => ({ paperId, title: `Paper ${paperId}`, ...extra })
const rejects = (fn: () => unknown, pattern: RegExp) =>
	assert.rejects(async () => fn(), (e: Error) => e instanceof ToolError && pattern.test(e.message))

// every shape keeps the margin from every other; a card's box is the CARD_SIZE card drawn round its node
function assertApart(records: TLRecord[]) {
	const boxes = [...shapeBoxes(records).values()]
	boxes.forEach((b, i) => assert.ok(isFree(boxes.slice(0, i), b), `box ${i} overlaps an earlier one`))
}

test('add_papers creates cards beside their neighbour, with defaults and attribution', () => {
	const ctx = newCtx()
	const first = addPapers(ctx, {
		papers: [paper('pmid:1', { authors: ['Itay Tirosh'], year: 2016, type: 'journal-article', foundBy: ['pubmed'] })],
	})
	assert.deepEqual(first, { added: ['pmid:1'], updated: [], skipped: [] })
	const result = addPapers(ctx, {
		papers: [
			paper('pmid:2', { near: 'pmid:1' }),
			paper('pmid:3', { near: 'pmid:1', kind: 'seed' }),
			paper('pmid:4', { near: 'pmid:1' }),
			paper('pmid:5', { retracted: true }),
		],
	})
	assert.deepEqual(result.added, ['pmid:2', 'pmid:3', 'pmid:4'])
	assert.deepEqual(result.skipped, [{ paperId: 'pmid:5', reason: 'retracted' }])

	const c1 = card(ctx, 'pmid:1')
	assert.equal(c1.props.type, 'article')
	assert.equal(c1.props.typeRaw, 'journal-article')
	assert.deepEqual(c1.props.foundBy, ['pubmed'])
	assert.equal(c1.props.kind, 'suggestion')
	assert.equal(c1.props.status, 'new')
	assert.equal(c1.props.working, true)
	assert.equal(c1.props.w, 48)
	assert.equal(card(ctx, 'pmid:3').props.kind, 'seed')
	assert.deepEqual(c1.meta, { createdBy: 'agent', onBehalfOf: 'm_ana', runId: 'run_0123456789ab', paperId: 'pmid:1' })

	// all four on one ring around pmid:1, no two cards overlapping as drawn
	assertApart(all(ctx))
	for (const id of ['pmid:2', 'pmid:3', 'pmid:4']) {
		const c = card(ctx, id)
		assert.ok(Math.abs(Math.hypot(c.x - c1.x, c.y - c1.y) - 212) < 1, `${id} is beside pmid:1`)
	}
})

test('add_papers without near rings a run’s papers around its first card, not in a row', () => {
	const ctx = newCtx()
	addPapers(ctx, { papers: [paper('first')] })
	addPapers(ctx, { papers: [paper('b'), paper('c')] })
	addPapers(ctx, { papers: [paper('d'), paper('e')] })
	const first = card(ctx, 'first')
	for (const id of ['b', 'c', 'd', 'e']) {
		const c = card(ctx, id)
		assert.ok(Math.abs(Math.hypot(c.x - first.x, c.y - first.y) - 212) < 1, `${id} is on the first ring`)
	}
	// another run starts its own ring, right of the content
	const other = { ...ctx, runId: 'run_ba9876543210' }
	addPapers(other, { papers: [paper('o1')] })
	addPapers(other, { papers: [paper('o2')] })
	const o1 = card(ctx, 'o1')
	assert.ok(o1.x > Math.max(...['b', 'c', 'd', 'e'].map((id) => card(ctx, id).x)))
	assert.ok(Math.abs(Math.hypot(card(ctx, 'o2').x - o1.x, card(ctx, 'o2').y - o1.y) - 212) < 1)
	assertApart(all(ctx))
})

test('add_papers updates its own cards in place and skips what people touched', () => {
	const ctx = newCtx()
	addPapers(ctx, { papers: [paper('a'), paper('b'), paper('c'), paper('seed', { kind: 'seed' })] })
	const before = card(ctx, 'a')
	const again = addPapers(ctx, { papers: [paper('a', { title: 'New title', year: 2020, venue: null })] })
	assert.deepEqual(again, { added: [], updated: ['a'], skipped: [] })
	const after = card(ctx, 'a')
	assert.equal(after.props.title, 'New title')
	assert.equal(after.props.year, 2020)
	assert.deepEqual([after.x, after.y, after.index], [before.x, before.y, before.index])
	assert.equal(after.props.working, true)

	patchShapes(ctx.boardId, [
		{ id: card(ctx, 'b').id, x: 999, y: 999, meta: { pinnedByHuman: true } },
		{ id: card(ctx, 'c').id, meta: { editedByHuman: true } },
	])
	putShapes(ctx.boardId, [{ id: paperShapeId('mine'), type: 'paper-card', props: { ...card(ctx, 'a').props, paperId: 'mine' }, meta: { author: 'm_bo' } }])
	const touched = addPapers(ctx, { papers: ['b', 'c', 'seed', 'mine'].map((id) => paper(id, { title: 'Changed' })) })
	assert.deepEqual(touched.skipped, [
		{ paperId: 'b', reason: 'moved by a person' },
		{ paperId: 'c', reason: 'edited by a person' },
		{ paperId: 'seed', reason: 'a seed already on the board' },
		{ paperId: 'mine', reason: 'made by a person' },
	])
	assert.equal(card(ctx, 'b').x, 999)
	assert.equal(card(ctx, 'b').props.title, 'Paper b')
})

test('set_scores merges per goal and checks the goals', async () => {
	const ctx = newCtx()
	addPapers(ctx, { papers: [paper('a')] })
	assert.deepEqual(setScores(ctx, { paperId: 'a', scores: { 'new-findings': { score: 0.9, fit: 'high', why: 'Same cells' } } }), { ok: true })
	setScores(ctx, { paperId: 'a', scores: { methods: { score: 0.2, fit: 'low', why: 'Other method' } } })
	assert.deepEqual(Object.keys(card(ctx, 'a').props.scores), ['new-findings', 'methods'])
	await rejects(() => setScores(ctx, { paperId: 'a', scores: { vibes: { score: 1, fit: 'high', why: '' } } }), /Not a goal/)
	await rejects(() => setScores(ctx, { paperId: 'zzz', scores: { methods: { score: 1, fit: 'high', why: '' } } }), /No card for zzz/)
	patchShapes(ctx.boardId, [{ id: card(ctx, 'a').id, meta: { editedByHuman: true } }])
	assert.deepEqual(setScores(ctx, { paperId: 'a', scores: { methods: { score: 1, fit: 'high', why: '' } } }), {
		ok: false,
		skipped: 'edited by a person',
	})
})

test('add_quote checks the abstract verbatim and returns stable IDs', async () => {
	const ctx = newCtx()
	addPapers(ctx, { papers: [paper('pmid:27124452', { url: 'https://pubmed.ncbi.nlm.nih.gov/27124452/' })] })
	const q = await addQuote(ctx, { paperId: 'pmid:27124452', text: 'Malignant cells showed two transcriptional programs.' })
	assert.deepEqual(q, { quoteId: 'q1' })
	const [quote] = card(ctx, 'pmid:27124452').props.quotes
	assert.equal(quote.text, 'Malignant cells showed two transcriptional programs.')
	assert.equal(quote.source, 'abstract')
	assert.equal(quote.verified, true)
	assert.match(quote.url, /^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/27124452\/#:~:text=Malignant%20cells%20showed/)
	assert.deepEqual(await addQuote(ctx, { paperId: 'pmid:27124452', text: ' Malignant  cells showed two transcriptional programs. ' }), { quoteId: 'q1' })
	assert.deepEqual(await addQuote(ctx, { paperId: 'pmid:27124452', text: 'from 19 melanomas' }), { quoteId: 'q2' })

	await rejects(() => addQuote(ctx, { paperId: 'pmid:27124452', text: 'Malignant cells showed three programs.' }), /isn't in the abstract/)
	papersDown = true
	await rejects(() => addQuote(ctx, { paperId: 'pmid:27124452', text: 'from 19 melanomas' }), /unreachable.*nothing was written/)
	papersDown = false
	await rejects(() => addQuote(ctx, { paperId: 'nope', text: 'x' }), /No card for nope/)
	assert.equal(card(ctx, 'pmid:27124452').props.quotes.length, 2)
})

test('set_card fills the card field by field, checks quote IDs and records provenance', async () => {
	const ctx = newCtx()
	addPapers(ctx, { papers: [paper('p')] })
	await addQuote(ctx, { paperId: 'p', text: 'from 19 melanomas' })
	const oneLine = 'Profiles the same melanoma cells as three of your seeds.'
	assert.deepEqual(setCard(ctx, { paperId: 'p', oneLine }), { ok: true, written: ['oneLine'] })
	const glance = [
		{ label: 'Samples', text: '19 melanomas', quoteId: 'q1', relation: 'same' as const },
		{ label: 'Method', text: 'scRNA-seq', quoteId: null, relation: 'adds' as const },
		{ label: 'Finding', text: 'Two programs', quoteId: null, relation: null },
	]
	const claims = [
		{ text: 'same melanoma cells', evidence: ['q1'] },
		{ text: 'three of your seeds', evidence: ['seeds'] },
	]
	const figure = { imageUrl: 'https://cdn.ncbi.nlm.nih.gov/fig3.jpg', label: 'Fig. 3', caption: 'UMAP', captionByAi: false }
	assert.deepEqual(setCard({ ...ctx, model: 'nvidia/other' }, { paperId: 'p', claims, glance, figure, gaps: ['No full text'] }), {
		ok: true,
		written: ['claims', 'glance', 'figure', 'gaps'],
	})
	const p = card(ctx, 'p').props
	assert.equal(p.oneLine, oneLine)
	assert.deepEqual(p.glance, glance)
	assert.deepEqual(p.claims, claims)
	assert.equal(p.figure?.label, 'Fig. 3')
	assert.equal(p.provenance.oneLine.model, 'nvidia/Nemotron-3.5-Super-VL')
	assert.equal(p.provenance.glance.model, 'nvidia/other')
	assert.ok(p.provenance.glance.at >= p.provenance.oneLine.at)

	await rejects(() => setCard(ctx, { paperId: 'p', claims: [{ text: 'same melanoma cells', evidence: ['q9'] }] }), /q9: no such quote/)
	await rejects(() => setCard(ctx, { paperId: 'p', claims: [{ text: 'not in the line', evidence: ['q1'] }] }), /word for word in oneLine/)
	await rejects(() => setCard(ctx, { paperId: 'p', glance: glance.map((s) => ({ ...s, quoteId: 'q7' })) }), /q7/)
	await rejects(() => setCard(ctx, { paperId: 'p' }), /Nothing to set/)
	// a new oneLine drops the claims it no longer contains
	setCard(ctx, { paperId: 'p', oneLine: 'Three of your seeds? No: same melanoma cells.' })
	assert.deepEqual(card(ctx, 'p').props.claims, [claims[0]])
})

test('link_papers draws bound arrows once, never resizes or moves a card, and respects citations, removed and hidden links', () => {
	const ctx = newCtx()
	addPapers(ctx, { papers: [paper('a'), paper('b', { near: 'a' }), paper('c', { near: 'a' }), paper('s', { kind: 'seed', near: 'a' })] })
	const places = () => ['a', 'b', 'c', 's'].map((id) => card(ctx, id)).map((c) => [c.x, c.y, c.props.w, c.props.h])
	const before = places()
	const result = linkPapers(ctx, {
		links: [
			{ from: 'a', to: 'b', kind: 'cites' },
			{ from: 'a', to: 'c', kind: 'similar' },
			{ from: 'a', to: 's', kind: 'cites' },
			{ from: 'a', to: 'a', kind: 'similar' },
			{ from: 'a', to: 'nope', kind: 'cites' },
			{ from: 'b', to: 'a', kind: 'similar' },
		],
	})
	assert.equal(result.linked.length, 3)
	assert.deepEqual(result.skipped.map((s) => s.reason), [
		'a paper can’t link to itself',
		'no card for nope',
		'already linked by a citation',
	])
	assert.equal(all(ctx).some((r) => r.id === linkShapeId('b', 'a', 'similar') || r.id === linkShapeId('a', 'b', 'similar')), false)

	const records = all(ctx)
	const arrowId = linkShapeId('a', 'b', 'cites') as TLShapeId
	const arrow = records.find((r) => r.id === arrowId) as TLShape
	assert.equal(arrow.type, 'arrow')
	assert.deepEqual(arrow.meta, {
		createdBy: 'agent',
		onBehalfOf: 'm_ana',
		runId: 'run_0123456789ab',
		kind: 'cites',
		label: '',
		by: 'pubmed',
		hiddenByHuman: false,
	})
	const bindings = records.filter((r): r is TLBinding => r.typeName === 'binding' && r.fromId === arrowId)
	assert.deepEqual(
		bindings.map((b) => [b.type, b.type === 'arrow' && b.props.terminal, b.toId]).sort(),
		[
			['arrow', 'end', card(ctx, 'b').id],
			['arrow', 'start', card(ctx, 'a').id],
		]
	)
	// v6 draws every paper as the same card, so links leave nodes as they are (D23)
	assert.deepEqual(places(), before)

	// repeats, and the reverse of a similar link, change nothing; a citation either way wins over similarity
	const count = all(ctx).length
	const again = linkPapers(ctx, {
		links: [
			{ from: 'a', to: 'b', kind: 'cites' },
			{ from: 'c', to: 'a', kind: 'similar' },
			{ from: 'a', to: 's', kind: 'similar' },
		],
	})
	assert.equal(again.linked.length, 2)
	assert.deepEqual(again.skipped, [{ from: 'a', to: 's', kind: 'similar', reason: 'already linked by a citation' }])
	assert.equal(all(ctx).length, count)

	// a person deletes the similar link and hides the citation
	const similarId = linkShapeId('a', 'c', 'similar')
	writeRoom(ctx.boardId, (txn) => {
		for (const r of [...txn.values()]) if (r.id === similarId || (r.typeName === 'binding' && r.fromId === similarId)) txn.delete(r.id)
	})
	patchShapes(ctx.boardId, [{ id: arrowId, meta: { hiddenByHuman: true } }])
	const blocked = linkPapers(ctx, { links: [{ from: 'c', to: 'a', kind: 'similar' }, { from: 'a', to: 'b', kind: 'cites' }] })
	assert.deepEqual(blocked.skipped.map((s) => s.reason), ['removed by a person', 'hidden by a person'])
	assert.deepEqual(getBoard(ctx).removedLinks, [{ from: 'a', to: 'c', kind: 'similar' }])
})

test('mark_working turns the ring on and off', () => {
	const ctx = newCtx()
	addPapers(ctx, { papers: [paper('a'), paper('b')] })
	assert.deepEqual(markWorking(ctx, { paperIds: ['a', 'b', 'x'], on: false }), {
		ok: true,
		skipped: [{ paperId: 'x', reason: 'no card on this board' }],
	})
	assert.equal(card(ctx, 'a').props.working, false)
	markWorking(ctx, { paperIds: ['a'], on: true })
	assert.equal(card(ctx, 'a').props.working, true)
})

test('add_note writes a note, pinned beside its paper with a note-pin binding', async () => {
	const ctx = newCtx({ runId: null })
	addPapers(ctx, { papers: [paper('a')] })
	const pinned = addNote(ctx, { text: 'Check the cohort size', paperId: 'a' })
	const loose = addNote(ctx, { text: 'Two programs\nworth a look' })
	const second = addNote(ctx, { text: 'Another', paperId: 'a' })
	const records = all(ctx)
	const note = records.find((r) => r.id === pinned.shapeId) as TLShape & { props: { richText: unknown } }
	assert.equal(note.type, 'note')
	assert.deepEqual(note.props.richText, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Check the cohort size' }] }] })
	assert.deepEqual(note.meta, { createdBy: 'agent', onBehalfOf: 'm_ana', runId: null, paperId: 'a' })
	// 24 px right of the card as drawn, level with its top; the pin is from the node
	const c = card(ctx, 'a')
	const drawn = { x: c.x + c.props.w / 2 - CARD_SIZE.w / 2, y: c.y + c.props.h / 2 - CARD_SIZE.h / 2 }
	assert.deepEqual([note.x, note.y], [drawn.x + CARD_SIZE.w + 24, drawn.y])
	const pin = records.find((r): r is TLBinding => r.typeName === 'binding' && r.fromId === pinned.shapeId)
	assert.equal(pin?.type, 'note-pin')
	assert.equal(pin?.toId, c.id)
	assert.deepEqual(pin?.props, { dx: note.x - c.x, dy: note.y - c.y })

	assertApart(records)
	const board = getBoard(ctx)
	assert.deepEqual(
		board.notes.map((n) => [n.shapeId, n.text, n.author, n.pinnedTo]),
		[
			[pinned.shapeId, 'Check the cohort size', 'agent', 'a'],
			[loose.shapeId, 'Two programs\nworth a look', 'agent', null],
			[second.shapeId, 'Another', 'agent', 'a'],
		]
	)
	assert.equal(board.papers[0].pinnedNotes, 2)
	await rejects(() => addNote(ctx, { text: 'x', paperId: 'nope' }), /No card for nope/)
})

test('get_board is a compact summary', () => {
	const ctx = newCtx()
	addPapers(ctx, { papers: [paper('a', { authors: ['Ana Ibáñez-Molero'], year: 2026 }), paper('s', { kind: 'seed' })] })
	setScores(ctx, { paperId: 'a', scores: { methods: { score: 0.5, fit: 'medium', why: 'Partly' } } })
	linkPapers(ctx, { links: [{ from: 'a', to: 's', kind: 'similar' }] })
	patchShapes(ctx.boardId, [{ id: card(ctx, 'a').id, props: { status: 'discarded' } }])
	const board = getBoard(ctx)
	assert.deepEqual(board.goals, ['new-findings', 'methods'])
	assert.deepEqual(board.papers.map((p) => p.paperId), ['s', 'a'])
	assert.deepEqual(board.papers[1], {
		paperId: 'a',
		label: 'Ibáñez-Molero 2026',
		title: 'Paper a',
		year: 2026,
		type: 'other',
		kind: 'suggestion',
		status: 'discarded',
		scores: { methods: { score: 0.5, fit: 'medium' } },
		working: true,
		cluster: null,
		humanTouched: false,
		pinnedNotes: 0,
	})
	assert.deepEqual(board.links, [{ from: 'a', to: 's', kind: 'similar', label: '', by: 'agent' }])
	assert.deepEqual(board.discardedIds, ['a'])
})
