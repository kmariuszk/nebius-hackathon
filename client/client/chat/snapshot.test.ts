import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Box, type Editor } from 'tldraw'
import type { SnapshotResult } from '../../shared/acpExt.ts'
import { openPaperId } from '../viewerState.ts'
import {
	exportingSnapshot,
	MAX_SIDE,
	planSnapshot,
	setSnapshotRenderer,
	snapshotScale,
	takeSnapshot,
	toBase64,
	withLinkArrows,
} from './snapshot.ts'

interface FakeShape {
	id: string
	type: string
	box: [x: number, y: number, w: number, h: number]
	props?: object
	hidden?: boolean
}

// A page of shapes behind the few editor calls the planner makes; `links` are arrows between two shapes.
function page(shapes: FakeShape[], links: [arrow: string, from: string, to: string][] = [], pins: [note: string, card: string][] = []) {
	const byId = new Map(shapes.map((s) => [s.id, { ...s, meta: {}, props: s.props ?? {} }]))
	const bindings = [
		...links.flatMap(([arrow, from, to]) => [
			{ type: 'arrow', fromId: arrow, toId: from, props: { terminal: 'start' } },
			{ type: 'arrow', fromId: arrow, toId: to, props: { terminal: 'end' } },
		]),
		...pins.map(([note, card]) => ({ type: 'note-pin', fromId: note, toId: card, props: {} })),
	]
	const id = (s: string | { id: string }) => (typeof s === 'string' ? s : s.id)
	return {
		getCurrentPageShapes: () => [...byId.values()],
		getShape: (s: string) => byId.get(s),
		isShapeHidden: (s: string | { id: string }) => !!byId.get(id(s))?.hidden,
		getShapePageBounds: (s: string | { id: string }) => {
			const box = byId.get(id(s))?.box
			return box && new Box(...box)
		},
		getViewportPageBounds: () => new Box(0, 0, 1000, 600),
		getBindingsToShape: (s: string | { id: string }, type: string) => bindings.filter((b) => b.toId === id(s) && b.type === type),
		getBindingsFromShape: (s: string | { id: string }, type: string) => bindings.filter((b) => b.fromId === id(s) && b.type === type),
	} as unknown as Editor
}

const card = (slug: string, author: string, year: number, box: FakeShape['box'], extra: Partial<FakeShape> = {}): FakeShape => ({
	id: `shape:paper-${slug}`,
	type: 'paper-card',
	box,
	props: { paperId: slug.replace('_', ':'), authors: [author], year },
	...extra,
})

const BOARD: FakeShape[] = [
	card('pmid_1', 'Itay Tirosh', 2016, [100, 100, 172, 70]),
	card('pmid_2', 'Jun Liu', 2022, [400, 100, 172, 70]),
	card('pmid_3', 'Moshe Sade-Feldman', 2018, [2400, 1800, 172, 70]),
	card('pmid_4', 'Ana Gone', 2020, [3000, 2000, 172, 70], { hidden: true }), // discarded, not shown
	{ id: 'shape:frame-1', type: 'frame', box: [50, 50, 700, 300] },
	{ id: 'shape:note-1', type: 'note', box: [2400, 1900, 200, 200] },
	{ id: 'shape:link-1', type: 'arrow', box: [272, 135, 128, 1] },
	{ id: 'shape:link-2', type: 'arrow', box: [500, 170, 1900, 1630] },
]
const LINKS: [string, string, string][] = [
	['shape:link-1', 'shape:paper-pmid_1', 'shape:paper-pmid_2'],
	['shape:link-2', 'shape:paper-pmid_2', 'shape:paper-pmid_3'],
]
const PINS: [string, string][] = [['shape:note-1', 'shape:paper-pmid_3']]

afterEach(() => openPaperId.set(null))

test('the long side is capped at 1,600 px, lowered by maxSide, and small areas are enlarged at most twice', () => {
	assert.equal(snapshotScale(3200, 1800), 0.5)
	assert.equal(Math.round(3200 * snapshotScale(3200, 1800)), MAX_SIDE)
	assert.equal(snapshotScale(1800, 3600, 900), 0.25)
	assert.equal(snapshotScale(3200, 1800, 4000), 0.5) // maxSide never raises the cap
	assert.equal(snapshotScale(400, 200), 2)
})

test('viewport: the view as it is on screen, captioned with what is in it and the open paper', () => {
	openPaperId.set('pmid:2')
	const plan = planSnapshot(page(BOARD, LINKS, PINS), { target: 'viewport' })
	assert.deepEqual(plan.bounds, new Box(0, 0, 1000, 600))
	assert.ok(!plan.ids.includes('shape:paper-pmid_4' as never), 'hidden shapes are left out')
	assert.equal(plan.caption, "The researcher's current view, with 2 cards, 1 cluster; Liu 2022 is open, but its panels aren't in the picture")
})

test('board: every shown shape, with a margin, and a caption that counts them', () => {
	const plan = planSnapshot(page(BOARD, LINKS, PINS), { target: 'board' })
	assert.deepEqual(plan.bounds, new Box(50 - 48, 50 - 48, 2550 + 96, 2050 + 96))
	assert.equal(plan.ids.length, 7)
	assert.equal(plan.caption, 'Whole board, with 3 cards, 1 cluster, 1 note')
})

test('shapes: the named papers plus their links, the cards at the other end and pinned notes', () => {
	const plan = planSnapshot(page(BOARD, LINKS, PINS), { target: 'shapes', paperIds: ['pmid:3'] })
	assert.deepEqual(new Set(plan.ids), new Set(['shape:paper-pmid_3', 'shape:link-2', 'shape:paper-pmid_2', 'shape:note-1']))
	assert.deepEqual(plan.bounds, new Box(400 - 48, 100 - 48, 2600 - 400 + 96, 2100 - 100 + 96))
	assert.equal(plan.caption, 'Sade-Feldman 2018, with 1 linked paper')

	const two = planSnapshot(page(BOARD, LINKS, PINS), { target: 'shapes', paperIds: ['pmid:1', 'pmid:2'], shapeIds: ['shape:frame-1'] })
	assert.equal(two.caption, 'Tirosh 2016, Liu 2022 and a cluster, with 1 linked paper')
})

test('reasons the agent can repeat: an empty board, an empty view, papers not on the board', () => {
	assert.throws(() => planSnapshot(page([]), { target: 'board' }), { message: 'The board is empty.' })
	const far = page([card('pmid_3', 'Sade-Feldman', 2018, [2400, 1800, 172, 70])])
	assert.throws(() => planSnapshot(far, { target: 'viewport' }), { message: "Nothing on the board is in the researcher's view right now." })
	assert.throws(() => planSnapshot(page(BOARD), { target: 'shapes', paperIds: ['pmid:4', 'pmid:9'] }), {
		message: "Those papers aren't on the board.",
	})
})

test('link arrows show only while a snapshot draws, also when the drawing fails', async () => {
	assert.equal(exportingSnapshot.get(), 0)
	const seen: number[] = []
	await withLinkArrows(async () => void seen.push(exportingSnapshot.get()))
	await assert.rejects(withLinkArrows(async () => {
		seen.push(exportingSnapshot.get())
		throw new Error('Could not create SVG')
	}))
	assert.deepEqual(seen, [1, 1])
	assert.equal(exportingSnapshot.get(), 0)
})

test('base64 matches Node for a picture bigger than one chunk', () => {
	const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 7) % 256)
	assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'))
})

const PNG: SnapshotResult = { mimeType: 'image/png', data: 'iVBORw0KGgo=', width: 2, height: 1, caption: 'Whole board, 1 card' }

test('takeSnapshot: the renderer answers, or a reason comes back fast', async () => {
	setSnapshotRenderer(async () => PNG)
	assert.deepEqual(await takeSnapshot({ target: 'board' }), PNG)

	// a hidden tab fails at once instead of waiting for a drawing that may never finish
	let started = Date.now()
	await assert.rejects(takeSnapshot({ target: 'board' }, { visible: () => false }), /tab is in the background/)
	assert.ok(Date.now() - started < 50)

	// a drawing that hangs fails at the timeout (10 s in the browser)
	const off = setSnapshotRenderer(() => new Promise(() => {}))
	started = Date.now()
	await assert.rejects(takeSnapshot({ target: 'board' }, { timeoutMs: 60 }), { message: 'Drawing the board took longer than 0.06 seconds.' })
	assert.ok(Date.now() - started < 1000)

	off()
	await assert.rejects(takeSnapshot({ target: 'board' }), { message: "The board isn't open in the researcher's browser." })
})
