import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Box } from 'tldraw'
import { paperShapeId } from '../../shared/ids.ts'
import { fakeEditor } from '../editing/fixtures/fakeEditor.ts'
import { followAgent, openPaperId } from '../viewerState.ts'
import { registerViewerActions } from './viewerActions.ts'
import { viewerBus, type ViewerAction, type ViewerEvents } from './viewerBus.ts'

// The Follow-the-agent gate: what the agent asks for is queued behind a busy viewer, or becomes a
// chat chip when Follow is off; what the viewer clicks always runs.

const CARD = {
	id: paperShapeId('pmid:1'),
	type: 'paper-card',
	props: { paperId: 'pmid:1', title: 'The paper', authors: ['Yang Liu'], year: 2022, w: 200, h: 100 },
}

function rig() {
	const { editor: base } = fakeEditor([CARD])
	const zooms: unknown[][] = []
	const editor = Object.assign(base, {
		inputs: { isPointing: false, isDragging: false, isPinching: false, isPanning: false },
		editing: null as string | null,
		getEditingShapeId() {
			return this.editing
		},
		getAncestorPageId: () => 'page:1',
		getViewportPageBounds: () => new Box(-10_000, -10_000, 20_000, 20_000),
		getZoomLevel: () => 1,
		zoomToBounds: (...args: unknown[]) => void zooms.push(args),
		setHintingShapes() {},
	})
	const chips: { label: string; action: ViewerAction }[] = []
	const offChip = viewerBus.on('chip', (c) => void chips.push(c))
	const notices: string[] = []
	const offNotice = viewerBus.on('notice', ({ text }) => void notices.push(text))
	const cleanup = registerViewerActions(editor)
	return {
		editor,
		zooms,
		chips,
		notices,
		done() {
			cleanup()
			offChip()
			offNotice()
		},
	}
}

const agent = <K extends keyof ViewerEvents>(type: K, p: ViewerEvents[K]) => viewerBus.emit(type, { ...p, from: 'agent' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test.beforeEach(() => {
	followAgent.set(true)
	openPaperId.set(null)
})

test("a local focus always runs, whatever Follow or the viewer's hands say", () => {
	const { editor, zooms, done } = rig()
	followAgent.set(false)
	editor.inputs.isPointing = true
	viewerBus.emit('focus', { paperIds: ['pmid:1'] })
	assert.equal(zooms.length, 1)
	done()
})

test('with Follow off, the agent’s focus becomes a "Show the paper" chip instead', () => {
	const { chips, zooms, done } = rig()
	followAgent.set(false)
	agent('focus', { paperIds: ['pmid:1'] })
	assert.equal(zooms.length, 0)
	assert.equal(chips.length, 1)
	assert.equal(chips[0].label, 'Show the paper')
	assert.deepEqual(chips[0].action, { type: 'focus', params: { paperIds: ['pmid:1'] } })
	done()
})

test('with Follow off, open_paper and tour get their own chips; highlight still runs', () => {
	const { chips, done } = rig()
	followAgent.set(false)
	agent('open_paper', { paperId: 'pmid:1' })
	agent('tour', { title: 'New', steps: [{ paperId: 'pmid:1', line: 'l' }, { paperId: 'pmid:2', line: 'm' }] })
	assert.equal(openPaperId.get(), null)
	assert.deepEqual(
		chips.map((c) => c.label),
		['Open Liu 2022', 'Start the tour (2 papers)']
	)
	// highlight is never gated: it doesn't move the camera
	agent('highlight', { paperIds: ['pmid:1'] })
	assert.equal(chips.length, 2)
	done()
})

test('with Follow on, a busy viewer queues the agent’s focus until the drag ends', async () => {
	const { editor, zooms, done } = rig()
	editor.inputs.isDragging = true
	agent('focus', { paperIds: ['pmid:1'] })
	assert.equal(zooms.length, 0)
	editor.inputs.isDragging = false
	await sleep(400) // the 250 ms idle check
	assert.equal(zooms.length, 1)
	done()
})

test('open_paper goes through the queue but never expires', async () => {
	const { editor, done } = rig()
	editor.editing = 'shape:x'
	agent('open_paper', { paperId: 'pmid:1' })
	assert.equal(openPaperId.get(), null)
	await sleep(6000) // longer than the 5 s focus expiry
	editor.editing = null
	await sleep(400)
	assert.equal(openPaperId.get(), 'pmid:1')
	done()
})
