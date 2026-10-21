import type { SessionNotification, SessionUpdate } from '@agentclientprotocol/sdk'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { chatReducer, initialChatState, type ChatAction, type ChatState, type ToolItem } from './chatState.ts'
import { findBoardTargets, formatCost, formatTokens, modelLabel, stopReasonText, toolMetaLine } from './format.ts'

// A turn as echo mode sends it (hand-written from the ACP schema until a capture exists).
const echoTurn: { params: SessionNotification }[] = JSON.parse(
	readFileSync(new URL('./fixtures/echoTurn.json', import.meta.url), 'utf8')
)

const reduce = (actions: ChatAction[], state: ChatState = initialChatState) => actions.reduce(chatReducer, state)
const update = (u: SessionUpdate): ChatAction => ({ type: 'update', update: u })

test('a recorded echo turn reduces to the panel state', () => {
	const state = reduce([
		{ type: 'send', text: 'hello board' },
		...echoTurn.map((m) => update(m.params.update)),
		{ type: 'stop', stopReason: 'end_turn' },
	])
	assert.equal(state.turns.length, 1)
	const [turn] = state.turns
	assert.equal(turn.prompt, 'hello board')
	assert.equal(turn.running, false)
	assert.equal(turn.stopReason, 'end_turn')
	// the plan is replaced, not appended
	assert.deepEqual(
		turn.plan?.map((e) => [e.content, e.status]),
		[
			['Read the prompt', 'completed'],
			['Echo it back', 'in_progress'],
		]
	)
	// thought, tool card, message, in arrival order; user_message_chunk and unknown kinds ignored
	assert.deepEqual(
		turn.items.map((i) => i.kind),
		['thought', 'tool', 'message']
	)
	const [thought, tool, message] = turn.items
	assert.deepEqual(thought, { kind: 'thought', key: thought.key, messageId: null, text: 'The user wants an echo.', done: true })
	assert.equal(message.kind === 'message' && message.text, 'You said: hello board. See [A paper](paper:pmid:1).')
	assert.equal(tool.kind, 'tool')
	const card = tool as ToolItem
	assert.equal(card.title, 'echo: add_papers')
	assert.equal(card.status, 'completed')
	assert.equal(card.toolKind, 'edit')
	assert.equal(card.summary, 'Added 1 paper')
	assert.deepEqual(card.rawInput, { papers: [{ paperId: 'pmid:1', title: 'A paper' }] })
	assert.deepEqual(card.meta, {
		agent: 'echo',
		model: 'nvidia/Nemotron-3.5-Super-VL',
		runId: 'run_0123456789ab',
		seconds: 0.4,
		tokens: 120,
		costUsd: 0.0004,
	})
	assert.deepEqual(state.usage, { used: 1500, size: 128000, cost: { amount: 0.0021, currency: 'USD' } })
	assert.deepEqual(findBoardTargets(card.rawOutput), { paperIds: ['pmid:1'], shapeIds: [] })
})

test('tool updates merge into their card field by field, and failed cards keep the error', () => {
	const state = reduce([
		{ type: 'send', text: 'go' },
		update({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'search: search', status: 'pending', rawInput: { q: 'cd8' } }),
		update({ sessionUpdate: 'tool_call', toolCallId: 'b', title: 'canvas: add_note', status: 'in_progress' }),
		update({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'in_progress', title: null }),
		update({
			sessionUpdate: 'tool_call_update',
			toolCallId: 'b',
			status: 'failed',
			content: [{ type: 'content', content: { type: 'text', text: 'Board is read-only' } }],
		}),
		update({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed', rawOutput: { hits: 3 }, _meta: { seconds: 2 } }),
	])
	const cards = state.turns[0].items as ToolItem[]
	assert.deepEqual(
		cards.map((c) => [c.toolCallId, c.title, c.status]),
		[
			['a', 'search: search', 'completed'],
			['b', 'canvas: add_note', 'failed'],
		]
	)
	assert.deepEqual(cards[0].rawInput, { q: 'cd8' })
	assert.deepEqual(cards[0].rawOutput, { hits: 3 })
	assert.deepEqual(cards[0].meta, { seconds: 2 })
	assert.equal(cards[1].summary, 'Board is read-only')
})

test('an update for an unknown tool call starts a card', () => {
	const state = reduce([{ type: 'send', text: 'go' }, update({ sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'in_progress' })])
	const card = state.turns[0].items[0] as ToolItem
	assert.deepEqual([card.title, card.status], ['Tool call', 'in_progress'])
})

test('text after a tool card starts a new message; thoughts collapse when the answer starts', () => {
	const state = reduce([
		{ type: 'send', text: 'go' },
		update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looking.' } }),
		update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }),
		update({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 't' }),
		update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Found it.' } }),
		update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Done.' } }),
	])
	const items = state.turns[0].items
	assert.deepEqual(
		items.map((i) => (i.kind === 'message' || i.kind === 'thought' ? `${i.kind}:${i.text}` : i.kind)),
		['message:Looking.', 'thought:hmm', 'tool', 'message:Found it. Done.']
	)
	assert.equal(items[1].kind === 'thought' && items[1].done, true)
	assert.equal(new Set(items.map((i) => i.key)).size, items.length, 'unique keys')
})

// A master turn as the harness sends it (mapping.py's chunks, trace.py's cards): narration, and
// whitespace-only chunks between the tool cards. Modelled on a live turn; no capture is checked in.
const masterTurn: { params: SessionNotification }[] = JSON.parse(
	readFileSync(new URL('./fixtures/masterTurn.json', import.meta.url), 'utf8')
)

test('whitespace-only chunks between tool cards join the message before them and never start an empty one', () => {
	const state = reduce([
		{ type: 'send', text: 'Start this board.' },
		...masterTurn.map((m) => update(m.params.update)),
		{ type: 'stop', stopReason: 'end_turn' },
	])
	const items = state.turns[0].items
	assert.deepEqual(
		items.map((i) =>
			i.kind === 'tool' ? i.title : `${i.kind}:${i.kind === 'message' || i.kind === 'thought' ? i.text : ''}`
		),
		[
			'message:Let me look at the board first.\n\n',
			'master: get_board',
			'master: search',
			'search: find_candidates',
			'message:The search found eight. Adding them near the seeds.',
			'master: add_papers',
			'message:I added [Sade-Feldman 2018](paper:pmid:30388456).\n\nIt ties the seeds together.',
		]
	)
	assert.ok(items.every((i) => i.kind !== 'message' || i.text.trim()), 'no blank bubbles')
	assert.deepEqual(state.turns[0].plan?.map((e) => e.status), ['completed', 'in_progress', 'pending'])
})

test('a whitespace-only chunk before any text starts nothing, not even a turn', () => {
	const blank = update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n' } })
	assert.equal(reduce([blank]), initialChatState)
	const state = reduce([
		{ type: 'send', text: 'go' },
		update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }),
		blank,
		update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: ' ' } }),
	])
	assert.deepEqual(
		state.turns[0].items.map((i) => i.kind === 'thought' && [i.text, i.done]),
		[['hmm ', false]],
		'a blank message chunk neither starts a message nor collapses the thought'
	)
})

test('a new messageId starts a new message', () => {
	const state = reduce([
		{ type: 'send', text: 'go' },
		update({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'one' } }),
		update({ sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'two' } }),
	])
	assert.equal(state.turns[0].items.length, 2)
})

test('cancelled turns, errors and disconnects end the running turn', () => {
	let state = reduce([{ type: 'send', text: 'a' }, { type: 'stop', stopReason: 'cancelled' }])
	assert.equal(state.turns[0].stopReason, 'cancelled')
	assert.equal(stopReasonText('cancelled'), 'Stopped')
	assert.equal(stopReasonText('end_turn'), null)
	assert.match(stopReasonText('max_tokens') ?? '', /length limit/)

	state = reduce([{ type: 'send', text: 'b' }, { type: 'error', message: 'Internal error' }], state)
	assert.deepEqual([state.turns[1].running, state.turns[1].error], [false, 'Internal error'])

	state = reduce(
		[
			{ type: 'send', text: 'c' },
			{ type: 'permission', requestId: 'p1', title: 'Delete the note?', options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }] },
			{ type: 'disconnected' },
		],
		state
	)
	const last = state.turns[2]
	assert.equal(last.running, false)
	assert.match(last.error ?? '', /connection closed/)
	assert.equal(last.items[0].kind === 'permission' && last.items[0].answer, 'cancelled')
})

test('permission answers are recorded on their prompt', () => {
	const state = reduce([
		{ type: 'send', text: 'go' },
		{ type: 'permission', requestId: 'p1', title: 'Add 3 papers?', options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }] },
		{ type: 'permission_answered', requestId: 'p1', answer: 'Allow' },
	])
	assert.equal(state.turns[0].items[0].kind === 'permission' && state.turns[0].items[0].answer, 'Allow')
})

test('reset starts a new epoch: later updates go to a new turn and usage starts over', () => {
	let state = reduce([{ type: 'send', text: 'a' }, ...echoTurn.map((m) => update(m.params.update))])
	state = reduce([{ type: 'reset' }, update({ sessionUpdate: 'plan', entries: [] })], state)
	assert.equal(state.turns[0].running, false)
	assert.equal(state.usage, null)
	assert.deepEqual(
		state.turns.map((t) => [t.epoch, t.prompt]),
		[
			[0, 'a'],
			[1, null],
		]
	)
})

test('display helpers', () => {
	assert.equal(modelLabel('nvidia/Nemotron-3.5-Super-VL'), 'Nemotron 3.5 Super VL')
	assert.equal(modelLabel('nvidia/Nemotron-3_5-Lightning'), 'Nemotron 3.5 Lightning')
	assert.equal(toolMetaLine({ model: 'nvidia/Nemotron-3_5-Lightning', seconds: 6.24, costUsd: 0.012 }), 'Nemotron 3.5 Lightning · 6.2 s · $0.01')
	assert.equal(toolMetaLine({ seconds: 14.2, costUsd: 0 }), '14 s')
	assert.equal(toolMetaLine({ costUsd: 0.0004 }), '<$0.01')
	assert.equal(formatCost(1.5, 'EUR'), '1.50 EUR')
	assert.deepEqual([formatTokens(950), formatTokens(1234), formatTokens(56_789), formatTokens(2_500_000)], ['950', '1.2k', '57k', '2.5M'])
})

test('board targets come from added papers and shape IDs, never from skipped entries', () => {
	assert.deepEqual(findBoardTargets({ added: [{ paperId: 'pmid:1' }], skipped: [{ paperId: 'pmid:2' }] }), {
		paperIds: ['pmid:1'],
		shapeIds: [],
	})
	assert.deepEqual(findBoardTargets({ shapeId: 'shape:agent-note-3f9a0c1d2e4b' }), {
		paperIds: [],
		shapeIds: ['shape:agent-note-3f9a0c1d2e4b'],
	})
	assert.deepEqual(findBoardTargets({ content: [{ type: 'text', text: 'not json' }] }), { paperIds: [], shapeIds: [] })
	assert.deepEqual(findBoardTargets(undefined), { paperIds: [], shapeIds: [] })
})

test('a show chip lands in the running turn, or in its own prompt-less turn', () => {
	const chip = { type: 'show' as const, label: 'Show the paper', action: { type: 'focus' as const, params: { paperIds: ['pmid:1'] } } }
	// while a turn runs the chip is appended to it
	let state = reduce([{ type: 'send', text: 'q' }, chip])
	assert.equal(state.turns.length, 1)
	const item = state.turns[0].items[0]
	assert.equal(item.kind, 'show')
	assert.equal(item.kind === 'show' && item.label, 'Show the paper')
	// with no turn running it gets a prompt-less turn of its own
	state = reduce([{ type: 'send', text: 'q' }, { type: 'stop', stopReason: 'end_turn' }, chip])
	assert.equal(state.turns.length, 2)
	assert.equal(state.turns[1].prompt, null)
	assert.equal(state.turns[1].running, false)
	assert.equal(state.turns[1].items[0].kind, 'show')
	// and on an empty chat
	state = reduce([chip])
	assert.equal(state.turns.length, 1)
	assert.equal(state.turns[0].prompt, null)
})
