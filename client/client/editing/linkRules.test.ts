import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boardApi } from '../api.ts'
import { hiddenMeta, hiddenToast, kindOf, labelledMeta, linkNote, linkOptions, linkTag } from './linkRules.ts'

test('what the link editor offers per kind', () => {
	// cites: label and hide, never delete
	assert.deepEqual(linkOptions('cites'), { hide: true, delete: false, recordRemoved: false })
	// similar: rename, hide, delete, and the agent is told it was removed
	assert.deepEqual(linkOptions('similar'), { hide: true, delete: true, recordRemoved: true })
	// yours or a teammate's: label, hide, delete
	assert.deepEqual(linkOptions('user'), { hide: true, delete: true, recordRemoved: false })
})

test('a link without a known kind is a person’s', () => {
	assert.equal(kindOf({ kind: 'cites' }), 'cites')
	assert.equal(kindOf({ kind: 'similar' }), 'similar')
	assert.equal(kindOf({ kind: 'user' }), 'user')
	assert.equal(kindOf({}), 'user')
})

test('labelling marks the link edited by a person and says who labelled it', () => {
	const agent = { createdBy: 'agent', kind: 'similar', label: '', by: 'agent', hiddenByHuman: false }
	assert.deepEqual(labelledMeta(agent, 'same cohort', 'm_ana'), {
		...agent,
		label: 'same cohort',
		labelBy: 'm_ana',
		editedByHuman: true,
	})
	// clearing a label is an edit too
	assert.deepEqual(labelledMeta({ kind: 'user', label: 'x' }, '', 'm_igor'), {
		kind: 'user',
		label: '',
		labelBy: 'm_igor',
		editedByHuman: true,
	})
})

test('hiding sets hiddenByHuman, so the strings and the canvas MCP leave it hidden', () => {
	assert.deepEqual(hiddenMeta({ kind: 'cites', label: 'a', hiddenByHuman: false }), {
		kind: 'cites',
		label: 'a',
		hiddenByHuman: true,
		editedByHuman: true,
	})
	assert.equal(hiddenToast('cites'), 'Link hidden. The citation stays in the data, just not on this board.')
	assert.equal(hiddenToast('similar'), 'Link hidden.')
})

test('the pill: your label, with cites after it on a citation; else the kind', () => {
	assert.equal(linkTag('cites', ''), 'cites')
	assert.equal(linkTag('cites', 'same cohort'), 'same cohort · cites')
	assert.equal(linkTag('similar', ''), 'similar')
	assert.equal(linkTag('similar', 'compare with'), 'compare with')
	assert.equal(linkTag('user', ''), 'linked')
})

test('the editor says where the link comes from', () => {
	assert.equal(
		linkNote('cites', 'Liu 2022', 'Tirosh 2016', 'pubmed', 'm_ana'),
		'From PubMed: Liu 2022 cites Tirosh 2016. Your label is added next to “cites”.'
	)
	assert.equal(linkNote('cites', 'A', 'B', 'openalex', 'm_ana').startsWith('From OpenAlex: A cites B.'), true)
	assert.equal(linkNote('similar', 'A', 'B', 'agent', 'm_ana'), 'The agent found similar abstracts. Your label replaces “similar”.')
	assert.equal(linkNote('user', 'A', 'B', 'm_ana', 'm_ana'), 'Drawn by you.')
	assert.equal(linkNote('user', 'A', 'B', 'm_igor', 'm_ana'), 'Drawn by a teammate.')
})

test('a deleted similar link goes to the board service’s removed links', async (t) => {
	const calls: { url: string; init: RequestInit }[] = []
	t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
		calls.push({ url, init })
		return new Response(null, { status: 204 })
	})
	await boardApi('b_1', 'm_ana').removeLink('pmid:1', 'pmid:9', 'similar')
	assert.equal(calls[0].url, '/api/v1/boards/b_1/removed-links')
	assert.equal(calls[0].init.method, 'PUT')
	assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer m_ana')
	assert.deepEqual(JSON.parse(String(calls[0].init.body)), { from: 'pmid:1', to: 'pmid:9', kind: 'similar' })
})
