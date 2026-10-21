import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChatBus, promptBlocks, type AskRequest } from './chatBus.ts'

test('a request made before any panel listens waits, and reaches the first panel once', () => {
	const bus = createChatBus()
	bus.ask({ text: 'Start this board.' })
	bus.ask({ text: 'Find more papers like Tirosh 2016' })
	const got: string[] = []
	const off = bus.onAsk((r) => got.push(r.text))
	assert.deepEqual(got, ['Start this board.', 'Find more papers like Tirosh 2016'])

	// a re-render (or React's strict-mode remount) subscribes again: nothing is sent twice
	off()
	const again: string[] = []
	bus.onAsk((r) => again.push(r.text))
	assert.deepEqual(again, [])
})

test('with a panel listening, a request goes straight to it; after it leaves, requests wait again', () => {
	const bus = createChatBus()
	const first: AskRequest[] = []
	const off = bus.onAsk((r) => first.push(r))
	bus.ask({ text: 'now' })
	assert.deepEqual(first.map((r) => r.text), ['now'])
	off()
	bus.ask({ text: 'later' })
	assert.equal(first.length, 1)
	const second: AskRequest[] = []
	bus.onAsk((r) => second.push(r))
	assert.deepEqual(second.map((r) => r.text), ['later'])
})

test('the newest panel takes requests; an older one unsubscribing late changes nothing', () => {
	const bus = createChatBus()
	const old: string[] = []
	const fresh: string[] = []
	const offOld = bus.onAsk((r) => old.push(r.text))
	bus.onAsk((r) => fresh.push(r.text))
	offOld()
	bus.ask({ text: 'hello' })
	assert.deepEqual([old, fresh], [[], ['hello']])
})

test('resources go after the text as embedded resource blocks', () => {
	const changes = { uri: 'tldraw://b_1/changes', mimeType: 'application/json', text: '{"added":[]}' }
	assert.deepEqual(promptBlocks({ text: 'Update suggestions', resources: [changes] }), [
		{ type: 'text', text: 'Update suggestions' },
		{ type: 'resource', resource: changes },
	])
	assert.deepEqual(promptBlocks({ text: 'hi' }), [{ type: 'text', text: 'hi' }])
})
