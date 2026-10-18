import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyVote, myVote, type VoteFields } from './votes.ts'

const fresh: VoteFields = { keepBy: [], discardBy: [], status: 'new', kind: 'suggestion' }

test('keeping a suggestion moves it to the collection', () => {
	assert.deepEqual(applyVote(fresh, 'm_me', 'keep'), { keepBy: ['m_me'], discardBy: [], status: 'kept', kind: 'kept' })
})

test('discarding marks it discarded', () => {
	assert.deepEqual(applyVote(fresh, 'm_me', 'discard'), {
		keepBy: [],
		discardBy: ['m_me'],
		status: 'discarded',
		kind: 'suggestion',
	})
})

test('votes both ways make it contested, and it stays a suggestion', () => {
	const kept = applyVote(fresh, 'm_ana', 'keep')
	const split = applyVote(kept, 'm_igor', 'discard')
	assert.equal(split.status, 'contested')
	assert.equal(split.kind, 'suggestion')
	assert.deepEqual(myVote(split, 'm_ana'), 'keep')
	assert.deepEqual(myVote(split, 'm_igor'), 'discard')
	assert.equal(myVote(split, 'm_ralph'), null)
})

test('changing your vote replaces it; taking it back (Undo) restores the card', () => {
	const kept = applyVote(fresh, 'm_me', 'keep')
	assert.deepEqual(applyVote(kept, 'm_me', 'discard').keepBy, [])
	assert.deepEqual(applyVote(kept, 'm_me', null), fresh)
})

test('Undo leaves other people’s votes alone', () => {
	const ana = applyVote(fresh, 'm_ana', 'keep')
	const both = applyVote(ana, 'm_me', 'discard')
	assert.deepEqual(applyVote(both, 'm_me', null), ana)
})

test('seeds stay seeds', () => {
	const seed: VoteFields = { ...fresh, kind: 'seed', status: 'kept' }
	assert.equal(applyVote(seed, 'm_me', 'discard').kind, 'seed')
})
