import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TLShape } from 'tldraw'
import { chipLabel, due, isFollowedCard, push, shouldMove, type QueuedAction } from './follow.ts'
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
	const titleOf = (id: string) => (id === 'pmid:1' ? 'The paper' : null)
	assert.equal(chipLabel({ type: 'focus', params: { paperIds: ['pmid:1'] } }, titleOf), 'Show the paper')
	assert.equal(
		chipLabel({ type: 'focus', params: { paperIds: ['pmid:1', 'pmid:2'], shapeIds: ['shape:x'] } }, titleOf),
		'Show 3 papers'
	)
	assert.equal(chipLabel({ type: 'open_paper', paperId: 'pmid:1' }, titleOf), 'Open The paper')
	assert.equal(chipLabel({ type: 'open_paper', paperId: 'pmid:gone' }, titleOf), 'Open the paper')
	const tour: ViewerAction = { type: 'tour', title: 'New', steps: [{ paperId: 'p1', line: '' }, { paperId: 'p2', line: '' }] }
	assert.equal(chipLabel(tour, titleOf), 'Start the tour (2 papers)')
})
