import assert from 'node:assert/strict'
import { test } from 'node:test'
import { glanceIcon } from './glance.ts'
import { noteAuthor, pinOffset, plainText } from './notes.ts'

test('a note’s rich text reads as plain text, one paragraph per line', () => {
	const doc = {
		type: 'doc',
		content: [
			{ type: 'paragraph', content: [{ type: 'text', text: 'Could we sort ' }, { type: 'text', text: 'clusters', marks: [{ type: 'bold' }] }] },
			{ type: 'paragraph', content: [{ type: 'text', text: 'from our biopsies?' }, { type: 'hardBreak' }, { type: 'text', text: 'Ask Igor' }] },
			{ type: 'paragraph' },
		],
	}
	assert.equal(plainText(doc), 'Could we sort clusters\nfrom our biopsies?\nAsk Igor')
	assert.equal(plainText({ type: 'doc', content: [{ type: 'paragraph' }] }), '')
	assert.equal(plainText(undefined), '')
})

test('note authors: you, the agent, or unknown', () => {
	assert.equal(noteAuthor({ author: 'm_me' }, 'm_me'), 'You')
	assert.equal(noteAuthor({ createdBy: 'agent', onBehalfOf: 'm_me' }, 'm_me'), 'Agent')
	assert.equal(noteAuthor({ author: 'm_other' }, 'm_me'), null)
	assert.equal(noteAuthor(undefined, 'm_me'), null)
})

test('pinned notes go 20 px right of the card, a little below its middle, each next one lower', () => {
	// a 48 px node's drawn card has its right edge at node.x + 24 + 86 = node.x + 110
	assert.deepEqual(pinOffset({ w: 48, h: 48 }, 0), { dx: 130, dy: 36 })
	assert.deepEqual(pinOffset({ w: 48, h: 48 }, 2), { dx: 130, dy: 104 })
	// the same place seedDemo.ts pins the demo note: n1.w / 2 + 106, n1.w / 2 + 12
	assert.deepEqual(pinOffset({ w: 60, h: 60 }, 0), { dx: 60 / 2 + 106, dy: 60 / 2 + 12 })
})

test('glance steps get an icon from their label', () => {
	assert.equal(glanceIcon('Samples'), 'samples')
	assert.equal(glanceIcon('Tested on'), 'samples')
	assert.equal(glanceIcon('Model'), 'samples')
	assert.equal(glanceIcon('Method'), 'method')
	assert.equal(glanceIcon('Methods reviewed'), 'method')
	assert.equal(glanceIcon('Readout'), 'readout')
	assert.equal(glanceIcon('Compares'), 'compare')
	assert.equal(glanceIcon('Checked in patients'), 'check')
	assert.equal(glanceIcon('Covers'), 'scope')
	assert.equal(glanceIcon('Finding'), 'finding')
	assert.equal(glanceIcon('Offers'), 'finding')
	assert.equal(glanceIcon('Something else'), 'method')
})
