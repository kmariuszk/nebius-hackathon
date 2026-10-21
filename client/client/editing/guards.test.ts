import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CITES_REFUSED, deleteRefusal, keepsBinding, PAPER_REFUSED, userLinkMeta } from './guards.ts'

test('papers can’t be deleted: people Discard them', () => {
	assert.equal(deleteRefusal({ type: 'paper-card', meta: { createdBy: 'agent' } }), PAPER_REFUSED)
	assert.equal(deleteRefusal({ type: 'paper-card', meta: {} }), PAPER_REFUSED)
	assert.equal(PAPER_REFUSED, 'Use Discard to take a paper off the board.')
})

test('citations can be hidden but not deleted; similar links and your own can go', () => {
	assert.equal(deleteRefusal({ type: 'arrow', meta: { kind: 'cites', by: 'pubmed' } }), CITES_REFUSED)
	assert.equal(CITES_REFUSED, 'Citations can be hidden, not deleted.')
	assert.equal(deleteRefusal({ type: 'arrow', meta: { kind: 'similar', by: 'agent' } }), null)
	assert.equal(deleteRefusal({ type: 'arrow', meta: { kind: 'user', by: 'm_ana' } }), null)
	assert.equal(deleteRefusal({ type: 'arrow', meta: {} }), null)
})

test('notes, clusters and everything else can be deleted', () => {
	for (const type of ['note', 'frame', 'text', 'geo']) assert.equal(deleteRefusal({ type, meta: {} }), null)
})

test('a refused delete keeps the paper’s links and pins; what really goes takes its own bindings', () => {
	// Delete on Liu 2022, a similar link to it and a note pinned to it: the paper stays
	const refused = new Set(['shape:paper-liu'])
	const gone = new Set(['shape:link-similar', 'shape:note'])
	// its citation from Tirosh 2016 stays bound at both ends
	assert.equal(keepsBinding({ fromId: 'shape:link-cites', toId: 'shape:paper-liu' }, refused, gone), true)
	// the deleted similar link and note leave, with their bindings
	assert.equal(keepsBinding({ fromId: 'shape:link-similar', toId: 'shape:paper-liu' }, refused, gone), false)
	assert.equal(keepsBinding({ fromId: 'shape:note', toId: 'shape:paper-liu' }, refused, gone), false)
	// bindings that don't touch a refused shape are tldraw's business
	assert.equal(keepsBinding({ fromId: 'shape:link-other', toId: 'shape:paper-other' }, refused, new Set()), false)
	// a refused cites link keeps both its ends
	const cites = new Set(['shape:link-cites'])
	assert.equal(keepsBinding({ fromId: 'shape:link-cites', toId: 'shape:paper-tirosh' }, cites, new Set()), true)
})

test('an arrow a person draws is theirs: kind user, empty label, by them', () => {
	assert.deepEqual(userLinkMeta({ author: 'm_ana' }, 'm_ana'), {
		author: 'm_ana',
		kind: 'user',
		label: '',
		by: 'm_ana',
		hiddenByHuman: false,
	})
	// a link that already has a kind (the agent's, or a pasted one) keeps it, as the same object
	const cites = { kind: 'cites', label: '', by: 'pubmed', hiddenByHuman: false }
	assert.equal(userLinkMeta(cites, 'm_ana'), cites)
})
