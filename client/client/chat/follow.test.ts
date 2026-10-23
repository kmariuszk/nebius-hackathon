import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Box, type TLShape } from 'tldraw'
import { chipLabel, due, isFollowedCard, push, registerFollow, shouldMove, type QueuedAction } from './follow.ts'
import type { ViewerAction } from './viewerBus.ts'

const card = (meta: Record<string, unknown>, type = 'paper-card') =>
	({ id: 'shape:c1', type, meta }) as unknown as TLShape

const ME = { memberId: 'm_me', runIds: new Set(['run_1']) }

test('isFollowedCard: a remote paper card the agent placed for me in this run', () => {
	const s = card({ createdBy: 'agent', onBehalfOf: 'm_me', runId: 'run_1' })
	assert.equal(isFollowedCard(s, 'remote', ME), true)
})

test('isFollowedCard: not for other members, other runs, local creates, humans or non-cards', () => {
	const mine = { createdBy: 'agent', onBehalfOf: 'm_me', runId: 'run_1' }
	assert.equal(isFollowedCard(card({ ...mine, onBehalfOf: 'm_ben' }), 'remote', ME), false)
	assert.equal(isFollowedCard(card({ ...mine, runId: 'run_old' }), 'remote', ME), false)
	assert.equal(isFollowedCard(card({ ...mine, runId: undefined }), 'remote', ME), false)
	assert.equal(isFollowedCard(card(mine), 'local', ME), false)
	assert.equal(isFollowedCard(card({ ...mine, createdBy: 'm_ben' }), 'remote', ME), false)
	assert.equal(isFollowedCard(card(mine, 'note'), 'remote', ME), false)
})

test('shouldMove: every skip rule from the design', () => {
	const base = { allInView: false, paperOpen: false, touring: false, lastInputAt: 0, now: 100_000 }
	assert.equal(shouldMove(base), true)
	assert.equal(shouldMove({ ...base, allInView: true }), false)
	assert.equal(shouldMove({ ...base, paperOpen: true }), false)
	assert.equal(shouldMove({ ...base, touring: true }), false)
	// input inside the last 3 seconds still counts as busy
	assert.equal(shouldMove({ ...base, lastInputAt: 98_000 }), false)
	assert.equal(shouldMove({ ...base, lastInputAt: 97_000 }), true)
})

const queued = (action: string, expiresAt: number | null = null): QueuedAction<string> => ({ action, at: 0, expiresAt })

test('the busy queue: arrival order, and nothing runs while the viewer is busy', () => {
	let q: QueuedAction<string>[] = []
	q = push(q, 'a', 0, null)
	q = push(q, 'b', 1, null)
	assert.deepEqual(due(q, 10, false), { run: [], rest: q })
	assert.deepEqual(due(q, 10, true).run, ['a', 'b'])
})

test('the busy queue: expired actions drop, unexpired and non-expiring run', () => {
	const q = [queued('focus', 5), queued('open', null), queued('tour', 50)]
	assert.deepEqual(due(q, 10, true), { run: ['open', 'tour'], rest: [] })
})

test('chipLabel: focus, open and tour wording', () => {
	// viewerActions passes the card's short label ("Liu 2022") for open_paper
	const titleOf = (id: string) => (id === 'pmid:1' ? 'Liu 2022' : null)
	assert.equal(chipLabel({ type: 'focus', params: { paperIds: ['pmid:1'] } }, titleOf), 'Show the paper')
	assert.equal(
		chipLabel({ type: 'focus', params: { paperIds: ['pmid:1', 'pmid:2'], shapeIds: ['shape:x'] } }, titleOf),
		'Show 3 papers'
	)
	assert.equal(chipLabel({ type: 'open_paper', paperId: 'pmid:1' }, titleOf), 'Open Liu 2022')
	assert.equal(chipLabel({ type: 'open_paper', paperId: 'pmid:gone' }, titleOf), 'Open the paper')
	const tour: ViewerAction = { type: 'tour', title: 'New', steps: [{ paperId: 'p1', line: '' }, { paperId: 'p2', line: '' }] }
	assert.equal(chipLabel(tour, titleOf), 'Start the tour (2 papers)')
})

test('registerFollow: a fresh-but-equal run-ID set keeps framing every card placed so far', async () => {
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
	// just enough editor: remote creates in, zoomToBounds out
	let onCreate: ((shape: TLShape, source: string) => void) | undefined
	const bounds = new Map<string, Box>()
	const zooms: Box[] = []
	const editor = {
		sideEffects: {
			registerAfterCreateHandler: (_k: string, fn: (s: TLShape, src: string) => void) => {
				onCreate = fn
				return () => {}
			},
		},
		on: () => {},
		off: () => {},
		getShape: (id: string) => ({ id, type: 'paper-card' }) as TLShape,
		getShapePageBounds: (s: TLShape) => bounds.get(s.id),
		getViewportPageBounds: () => new Box(0, 0, 1, 1), // never "all in view"
		getZoomLevel: () => 1,
		zoomToBounds: (box: Box) => void zooms.push(box),
	} as unknown as import('tldraw').Editor
	// the busy queue runs actions once idle; the stub's runs right away
	let runId = 'run_1'
	registerFollow(editor, { memberId: 'm_me', runIds: () => new Set([runId]), enqueue: (run) => void run() })

	const placed = (id: string, box: Box, run = runId) => {
		bounds.set(id, box)
		onCreate!(
			{ id, type: 'paper-card', meta: { createdBy: 'agent', onBehalfOf: 'm_me', runId: run } } as unknown as TLShape,
			'remote'
		)
	}
	placed('shape:c1', new Box(0, 0, 10, 10))
	await sleep(700) // batch 1 -> a move
	placed('shape:c2', new Box(100, 100, 10, 10))
	await sleep(700) // batch 2 -> the move frames c1 and c2, not c2 alone
	assert.equal(zooms.length, 2)
	// the second move's box spans both cards (c1 at 0,0 and c2 at 100,100)
	const second = zooms[1]
	assert.equal(second.minX, 0)
	assert.equal(second.maxX, 110)
	assert.equal(second.maxY, 110)

	// a new run resets the framed set: c3 is framed alone
	runId = 'run_2'
	placed('shape:c3', new Box(-50, -50, 10, 10))
	await sleep(700)
	assert.equal(zooms.length, 3)
	assert.equal(zooms[2].minX, -50)
	assert.equal(zooms[2].maxX, -40)
})
