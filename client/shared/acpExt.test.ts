import assert from 'node:assert/strict'
import { test } from 'node:test'
import { focusParams, highlightParams, openPaperParams, snapshotParams, tourParams } from './acpExt.ts'

const sessionId = 's_0123456789ab'

test('accepts the payloads the harness sends', () => {
	// what harness/board/viewer.py sends (T06), including None for unset fields
	assert.deepEqual(focusParams.parse({ sessionId, paperIds: ['pmid:1'], shapeIds: [] }), {
		sessionId,
		paperIds: ['pmid:1'],
		shapeIds: [],
	})
	assert.ok(focusParams.parse({ sessionId, shapeIds: ['shape:a'], inset: 64, animate: false }))
	assert.ok(focusParams.parse({ sessionId, paperIds: null, shapeIds: ['shape:a'], inset: null }))
	assert.equal(highlightParams.parse({ sessionId, paperIds: ['pmid:1'], durationMs: 6000 }).durationMs, 6000)
	assert.equal(openPaperParams.parse({ sessionId, paperId: 'pmid:34290406' }).paperId, 'pmid:34290406')
	const tour = tourParams.parse({ sessionId, steps: [{ paperId: 'pmid:1', line: 'Strongest match' }] })
	assert.equal(tour.title, 'Catch-up')
	assert.ok(snapshotParams.parse({ sessionId, target: 'shapes', paperIds: ['pmid:1'], maxSide: 1600 }))
	assert.ok(snapshotParams.parse({ sessionId, target: 'paper_page', paperId: 'pmid:1', page: 3 }))
})

test('keeps unknown extra fields out', () => {
	assert.deepEqual(openPaperParams.parse({ sessionId, paperId: 'pmid:1', extra: 1 }), { sessionId, paperId: 'pmid:1' })
})

test('rejects payloads without a sessionId', () => {
	for (const [schema, params] of [
		[focusParams, { paperIds: ['pmid:1'] }],
		[highlightParams, { paperIds: ['pmid:1'] }],
		[openPaperParams, { paperId: 'pmid:1' }],
		[tourParams, { title: 'x', steps: [] }],
		[snapshotParams, { target: 'viewport' }],
	] as const) {
		assert.equal(schema.safeParse(params).success, false, JSON.stringify(params))
		assert.equal(schema.safeParse({ ...params, sessionId: '' }).success, false)
	}
})

test('rejects malformed fields', () => {
	assert.equal(focusParams.safeParse({ sessionId, paperIds: 'pmid:1' }).success, false)
	assert.equal(openPaperParams.safeParse({ sessionId }).success, false)
	assert.equal(snapshotParams.safeParse({ sessionId, target: 'everything' }).success, false)
	assert.equal(tourParams.safeParse({ sessionId, steps: [{ paperId: 'pmid:1' }] }).success, false)
})
