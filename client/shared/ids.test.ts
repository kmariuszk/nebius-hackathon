import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { agentShapeId, linkShapeId, paperShapeId, RUN_ID_PATTERN } from './ids.ts'

const fixtures: [string, string][] = JSON.parse(
	readFileSync(new URL('./fixtures/paper-ids.json', import.meta.url), 'utf8')
)

test('paper shape IDs match the fixture the harness also checks', () => {
	for (const [paperId, shapeId] of fixtures) assert.equal(paperShapeId(paperId), shapeId, paperId)
})

test('link IDs are stable per pair and kind', () => {
	assert.equal(linkShapeId('pmid:1', 'pmid:2', 'cites'), 'shape:link-cites-pmid_1--pmid_2')
	assert.notEqual(linkShapeId('pmid:1', 'pmid:2', 'cites'), linkShapeId('pmid:1', 'pmid:2', 'similar'))
})

test('agent shape IDs carry the kind and 12 hex characters', () => {
	assert.match(agentShapeId('note'), /^shape:agent-note-[0-9a-f]{12}$/)
	assert.match('run_0123456789ab', RUN_ID_PATTERN)
})
