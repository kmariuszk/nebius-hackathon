import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { ApiError } from '../api.ts'
import { castVote, myVote } from './votes.ts'

// The vote rules themselves are tested with the server (server/triage.test.ts).

const realFetch = globalThis.fetch
afterEach(() => {
	globalThis.fetch = realFetch
})

function fakeFetch(status: number, body: unknown) {
	const calls: { url: string; init: RequestInit }[] = []
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init: init ?? {} })
		return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
	}
	return calls
}

test('myVote reads this member’s vote off the card', () => {
	const props = { keepBy: ['m_ana'], discardBy: ['m_igor'] }
	assert.equal(myVote(props, 'm_ana'), 'keep')
	assert.equal(myVote(props, 'm_igor'), 'discard')
	assert.equal(myVote(props, 'm_ralph'), null)
})

test('castVote sends the vote to the board service and returns the previous one for Undo', async () => {
	const calls = fakeFetch(200, { status: 'contested', keepBy: ['m_ana'], discardBy: ['m_me'] })
	const before = await castVote('b1', { paperId: 'doi:10.1/x', keepBy: ['m_ana', 'm_me'], discardBy: [] }, 'm_me', 'discard')
	assert.equal(before, 'keep')
	assert.equal(calls[0].url, '/api/v1/boards/b1/papers/doi%3A10.1%2Fx/vote')
	assert.equal(calls[0].init.method, 'PUT')
	assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer m_me')
	assert.deepEqual(JSON.parse(String(calls[0].init.body)), { decision: 'discard' })
})

test('a vote the board service refuses is an ApiError with its code', async () => {
	fakeFetch(404, { error: { code: 'not_found', message: 'No card for pmid:1 on this board' } })
	await assert.rejects(
		castVote('b1', { paperId: 'pmid:1', keepBy: [], discardBy: [] }, 'm_me', 'keep'),
		(e: ApiError) => e instanceof ApiError && e.status === 404 && e.code === 'not_found' && /No card/.test(e.message)
	)
})
