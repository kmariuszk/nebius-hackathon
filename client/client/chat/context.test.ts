import type { ContentBlock } from '@agentclientprotocol/sdk'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Box, type Editor } from 'tldraw'
import type { SnapshotResult } from '../../shared/acpExt.ts'
import { defaultPaperCardProps } from '../../shared/shapes.ts'
import { currentGoal, openPaperId } from '../viewerState.ts'
import { addBoardContext, contextResources, MAX_SHAPES, PICTURE_LINE, SHAPE_MIME, toContextShape } from './context.ts'
import type { SnapshotRequest } from './snapshot.ts'

interface Fake {
	id: string
	type: string
	props?: object
	meta?: object
	parentId?: string
	text?: string
	box?: [number, number, number, number]
}

// A board behind the editor calls the context makes; `selected` are the selected shape IDs.
function board(shapes: Fake[], selected: string[], bindings: { type: string; fromId: string; toId: string; props: object }[] = []) {
	const byId = new Map(shapes.map((s) => [s.id, { meta: {}, props: {}, box: [0, 0, 10, 10], ...s }]))
	const id = (s: string | { id: string }) => (typeof s === 'string' ? s : s.id)
	return {
		getSelectedShapes: () => selected.map((s) => byId.get(s)),
		getShape: (s: string) => byId.get(s),
		getCurrentPageShapes: () => [...byId.values()],
		getSortedChildIdsForParent: (p: string) => [...byId.values()].filter((s) => s.parentId === p).map((s) => s.id),
		getShapeUtil: () => ({ getText: (s: Fake) => s.text }),
		getBindingsFromShape: (s: string | { id: string }, type: string) => bindings.filter((b) => b.fromId === id(s) && b.type === type),
		isShapeHidden: () => false,
		getShapePageBounds: (s: string | { id: string }) => new Box(...(byId.get(id(s))!.box as [number, number, number, number])),
		getViewportPageBounds: () => new Box(0, 0, 1000, 600),
		getZoomLevel: () => 0.756,
	} as unknown as Editor
}

const card = (paperId: string, props: object = {}, box?: Fake['box']): Fake => ({
	id: `shape:paper-${paperId.replace(':', '_')}`,
	type: 'paper-card',
	props: defaultPaperCardProps(paperId, { title: `Paper ${paperId}`, year: 2022, ...props }),
	...(box ? { box } : {}),
})

const LIU = card('pmid:2', {
	status: 'kept',
	scores: { methods: { score: 0.8, fit: 'high', why: 'Same spatial method.' } },
	figure: { imageUrl: 'https://pmc/f2.jpg', label: 'Figure 2', caption: 'UMAP.', captionByAi: false },
})
const NOTE: Fake = { id: 'shape:note-1', type: 'note', text: ' Check the cohort size ', meta: { author: 'm_ana' } }
const LINK: Fake = { id: 'shape:link-cites-pmid_1--pmid_2', type: 'arrow', text: '', meta: { kind: 'cites', createdBy: 'agent' } }
const FRAME: Fake = { id: 'shape:cluster-c1', type: 'frame', props: { name: 'Spatial methods' } }
const BINDINGS = [
	{ type: 'note-pin', fromId: NOTE.id, toId: LIU.id, props: {} },
	{ type: 'arrow', fromId: LINK.id, toId: 'shape:paper-pmid_1', props: { terminal: 'start' } },
	{ type: 'arrow', fromId: LINK.id, toId: LIU.id, props: { terminal: 'end' } },
]

afterEach(() => {
	openPaperId.set(null)
	currentGoal.set('new-findings')
})

test('each shape becomes compact JSON: papers with fit and why for this viewer\'s goal, notes, links, clusters', () => {
	currentGoal.set('methods')
	const editor = board([card('pmid:1', {}), { ...LIU, parentId: FRAME.id }, NOTE, LINK, FRAME], [], BINDINGS)
	assert.deepEqual(toContextShape(editor, editor.getShape(LIU.id as never)!, 'methods'), {
		shapeId: LIU.id,
		type: 'paper-card',
		paperId: 'pmid:2',
		title: 'Paper pmid:2',
		year: 2022,
		status: 'kept',
		fit: 'high',
		why: 'Same spatial method.',
		figure: 'Figure 2',
	})
	assert.deepEqual(toContextShape(editor, editor.getShape(NOTE.id as never)!, 'methods'), {
		shapeId: NOTE.id,
		type: 'note',
		text: 'Check the cohort size',
		pinnedTo: 'pmid:2',
		author: 'm_ana',
	})
	assert.deepEqual(toContextShape(editor, editor.getShape(LINK.id as never)!, 'methods'), {
		shapeId: LINK.id,
		type: 'arrow',
		from: 'pmid:1',
		to: 'pmid:2',
		kind: 'cites',
		createdBy: 'agent',
	})
	assert.deepEqual(toContextShape(editor, editor.getShape(FRAME.id as never)!, 'methods'), {
		shapeId: FRAME.id,
		type: 'frame',
		label: 'Spatial methods',
		paperIds: ['pmid:2'],
	})
})

const json = (b: ContentBlock) => (b.type === 'resource' && 'text' in b.resource ? JSON.parse(b.resource.text) : null)

test('up to 20 selected shapes, a line for the rest, the open paper, then the view summary', () => {
	const cards = Array.from({ length: 23 }, (_, i) => card(`pmid:${i + 10}`, {}, [i * 250, 0, 172, 70]))
	openPaperId.set('pmid:2')
	const editor = board([...cards, LIU, NOTE], cards.map((c) => c.id))
	const blocks = contextResources(editor, 'demo')
	assert.equal(blocks.length, MAX_SHAPES + 3)
	const first = blocks[0]
	assert.ok(first.type === 'resource')
	assert.equal(first.resource.uri, 'tldraw://demo/shape:paper-pmid_10')
	assert.equal(first.resource.mimeType, SHAPE_MIME)
	assert.deepEqual(blocks[MAX_SHAPES], { type: 'text', text: 'And 3 more selected shapes, not listed.' })
	assert.equal(json(blocks[MAX_SHAPES + 1]).open, true)
	assert.equal(json(blocks[MAX_SHAPES + 1]).paperId, 'pmid:2')
	const view = blocks[MAX_SHAPES + 2]
	assert.ok(view.type === 'resource')
	assert.equal(view.resource.uri, 'tldraw://demo/viewport')
	assert.deepEqual(json(view), {
		visiblePaperIds: ['pmid:10', 'pmid:11', 'pmid:12', 'pmid:13', 'pmid:14', 'pmid:2'],
		visibleNoteCount: 1,
		zoom: 0.76,
		openPaperId: 'pmid:2',
	})

	// an open paper that is also selected is listed once, as selected
	const once = contextResources(board([LIU], [LIU.id]), 'demo')
	assert.deepEqual(
		once.map((b) => (b.type === 'resource' ? b.resource.uri : b.type)),
		[`tldraw://demo/${LIU.id}`, 'tldraw://demo/viewport']
	)
	assert.equal(json(once[0]).open, undefined)
})

const SHOT: SnapshotResult = { mimeType: 'image/png', data: 'iVBORw0KGgo=', width: 1600, height: 980, caption: "The researcher's current view, with 1 card" }
const CHANGES = { uri: 'tldraw://demo/changes', mimeType: 'application/json', text: '[]' }
const PROMPT: ContentBlock[] = [{ type: 'text', text: 'What do these have in common?' }, { type: 'resource', resource: CHANGES }]
const kinds = (blocks: ContentBlock[]) =>
	blocks.map((b) => (b.type === 'resource' ? b.resource.uri : b.type === 'text' ? `text: ${b.text}` : `${b.type}`))

test('with "Include my view": text, selection, view summary, the request\'s resources, then the line and the picture', async () => {
	const asked: SnapshotRequest[] = []
	const take = async (request: SnapshotRequest) => (asked.push(request), SHOT)
	const blocks = await addBoardContext(board([LIU], [LIU.id]), 'demo', PROMPT, { includeView: true, take })
	assert.deepEqual(kinds(blocks), [
		'text: What do these have in common?',
		`tldraw://demo/${LIU.id}`,
		'tldraw://demo/viewport',
		'tldraw://demo/changes',
		`text: ${PICTURE_LINE}The researcher's current view, with 1 card`,
		'image',
	])
	assert.deepEqual(blocks.at(-1), { type: 'image', mimeType: 'image/png', data: SHOT.data })
	assert.deepEqual(asked, [{ target: 'viewport' }])
})

test('with "Include my view" off no picture is taken or sent', async () => {
	let taken = 0
	const take = async () => (taken++, SHOT)
	const blocks = await addBoardContext(board([LIU], []), 'demo', PROMPT.slice(0, 1), { includeView: false, take })
	assert.deepEqual(kinds(blocks), ['text: What do these have in common?', 'tldraw://demo/viewport'])
	assert.equal(taken, 0)
	assert.ok(!blocks.some((b) => b.type === 'image'))
})

test('a view that can\'t be drawn (an empty board) sends the prompt without a picture', async () => {
	const take = async () => {
		throw new Error('The board is empty.')
	}
	const quiet = console.info
	console.info = () => {}
	try {
		const blocks = await addBoardContext(board([], []), 'demo', PROMPT.slice(0, 1), { includeView: true, take })
		assert.deepEqual(kinds(blocks), ['text: What do these have in common?', 'tldraw://demo/viewport'])
	} finally {
		console.info = quiet
	}
})
