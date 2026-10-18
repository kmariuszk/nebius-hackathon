import assert from 'node:assert/strict'
import { test } from 'node:test'
import { glanceIcon } from './glance.ts'
import { newNoteOffset, noteAuthor, plainText } from './notes.ts'

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

test('new notes fan out to the right of the card', () => {
	assert.deepEqual(newNoteOffset({ w: 60, h: 60 }, 0), { dx: 84, dy: -26 })
	assert.deepEqual(newNoteOffset({ w: 60, h: 60 }, 2), { dx: 84, dy: 34 })
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
