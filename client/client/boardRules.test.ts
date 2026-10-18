import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createdMeta, nextMeta, type ShapeLike } from './boardRules.ts'

const agentMeta = { createdBy: 'agent', onBehalfOf: 'm_abcdefghij', runId: null }

function shape(over: Partial<ShapeLike> = {}, props: object = {}): ShapeLike {
	return {
		type: 'paper-card',
		x: 100,
		y: 200,
		rotation: 0,
		parentId: 'page:page',
		props: { w: 40, h: 40, title: 'A', status: 'new', kind: 'suggestion', keepBy: [], discardBy: [], ...props },
		meta: agentMeta,
		...over,
	}
}

test('a person moving an agent shape pins it', () => {
	const prev = shape()
	for (const change of [{ x: 120 }, { y: 0 }, { rotation: 0.5 }, { parentId: 'shape:frame1' }]) {
		const meta = nextMeta(prev, shape(change), 'user')
		assert.equal(meta.pinnedByHuman, true)
		assert.equal(meta.editedByHuman, undefined)
		assert.equal(meta.createdBy, 'agent')
	}
})

test('a person editing an agent shape marks it edited', () => {
	const meta = nextMeta(shape(), shape({}, { title: 'B' }), 'user')
	assert.deepEqual(meta, { ...agentMeta, editedByHuman: true })
	const both = nextMeta(shape(), shape({ x: 1 }, { title: 'B' }), 'user')
	assert.deepEqual(both, { ...agentMeta, pinnedByHuman: true, editedByHuman: true })
})

test('votes, board state and size do not lock a paper card', () => {
	const prev = shape()
	for (const props of [{ status: 'kept' }, { kind: 'kept' }, { keepBy: ['m_x'] }, { discardBy: ['m_y'] }, { w: 56, h: 56 }]) {
		assert.equal(nextMeta(prev, shape({}, props), 'user'), agentMeta)
	}
	// on other shapes a resize is an edit
	const geo = nextMeta(shape({ type: 'geo' }), shape({ type: 'geo' }, { w: 80 }), 'user')
	assert.equal(geo.editedByHuman, true)
})

test('remote changes never set flags', () => {
	assert.equal(nextMeta(shape(), shape({ x: 1 }, { title: 'B' }), 'remote'), agentMeta)
})

test("a person's own shapes are never flagged", () => {
	const mine = { author: 'm_abcdefghij' }
	const meta = nextMeta(shape({ meta: mine }), shape({ meta: mine, x: 5 }, { title: 'B' }), 'user')
	assert.equal(meta, mine)
})

test('nothing changes when nothing moved or the flags are already set', () => {
	const prev = shape()
	assert.equal(nextMeta(prev, shape({}, { keepBy: [] }), 'user'), agentMeta, 'equal by value')
	const flagged = { ...agentMeta, pinnedByHuman: true, editedByHuman: true }
	assert.equal(nextMeta(shape({ meta: flagged }), shape({ meta: flagged, x: 9 }, { title: 'C' }), 'user'), flagged)
})

test('a person creating a shape becomes its author; agent shapes keep their attribution', () => {
	assert.deepEqual(createdMeta({}, 'user', 'm_abcdefghij'), { author: 'm_abcdefghij' })
	assert.deepEqual(createdMeta({ author: 'm_other00000' }, 'user', 'm_abcdefghij'), { author: 'm_abcdefghij' })
	assert.equal(createdMeta(agentMeta, 'user', 'm_abcdefghij'), agentMeta)
	const remote = {}
	assert.equal(createdMeta(remote, 'remote', 'm_abcdefghij'), remote)
})
