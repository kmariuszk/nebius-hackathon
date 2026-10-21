import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultPaperCardProps } from '../../shared/shapes.ts'
import { changes } from '../pinboard/changes.ts'
import { registerBoardSideEffects } from '../sideEffects.ts'
import { fakeEditor } from './fixtures/fakeEditor.ts'
import { CITES_REFUSED, deleteRefusal, keepsBinding, PAPER_REFUSED, registerGuards, userLinkMeta } from './guards.ts'

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

const card = (id: string, paperId: string, at: Partial<{ x: number; y: number; parentId: string }> = {}) => ({
	id,
	type: 'paper-card',
	x: 0,
	y: 0,
	props: defaultPaperCardProps(paperId, { w: 48, h: 48 }),
	meta: { createdBy: 'agent' },
	...at,
})

test('Delete on a paper is refused with its links and pinned note kept; the next delete is judged afresh', () => {
	const liu = card('shape:paper-liu', 'pmid:2', { x: 100, y: 100 })
	const tirosh = card('shape:paper-tirosh', 'pmid:1', { x: 500, y: 100 })
	const arrow = (id: string, kind: string) => ({ id, type: 'arrow', props: { start: 'bound', end: 'bound' }, meta: { kind } })
	const { editor, fake, shapes, bindings } = fakeEditor([
		liu,
		tirosh,
		arrow('shape:link-cites', 'cites'),
		arrow('shape:link-similar', 'similar'),
		{ id: 'shape:note', type: 'note', x: 230, y: 136 },
	])
	const bind = (fromId: string, toId: string, type = 'arrow', terminal = 'end') =>
		bindings.set(`binding:${fromId}-${toId}`, { id: `binding:${fromId}-${toId}`, type, fromId, toId, props: { terminal }, meta: {} })
	bind('shape:link-cites', tirosh.id, 'arrow', 'start')
	bind('shape:link-cites', liu.id)
	bind('shape:link-similar', tirosh.id, 'arrow', 'start')
	bind('shape:link-similar', liu.id)
	bind('shape:note', liu.id, 'note-pin')
	const before = [...bindings.keys()]
	const toasts: string[] = []
	const off = registerGuards(editor, (text) => toasts.push(text))
	try {
		fake.deleteShapes([liu.id])
		assert.ok(shapes.has(liu.id))
		assert.deepEqual([...bindings.keys()], before)
		// the arrows still end on the paper rather than coming loose
		assert.deepEqual(shapes.get('shape:link-cites')!.props, { start: 'bound', end: 'bound' })
		assert.deepEqual(toasts, [PAPER_REFUSED])

		// nothing refused is left over: unpinning the note now takes its pin away
		fake.deleteBinding(`binding:shape:note-${liu.id}`)
		assert.ok(!bindings.has(`binding:shape:note-${liu.id}`))
		// and deleting the similar link takes its ends with it
		fake.deleteShapes(['shape:link-similar'])
		assert.ok(!shapes.has('shape:link-similar'))
		assert.deepEqual(
			[...bindings.values()].filter((b) => b.fromId === 'shape:link-similar'),
			[]
		)
		assert.deepEqual(toasts, [PAPER_REFUSED])
	} finally {
		off()
	}
})

test('deleting a cluster leaves its papers where they were, unpinned, and records no move', () => {
	const frame = { id: 'shape:cluster-c1', type: 'frame', x: 400, y: 300, props: { name: 'Spatial methods', w: 600, h: 400 }, meta: { clusterId: 'c1', createdBy: 'agent' } }
	const inside = [card('shape:paper-a', 'pmid:10', { x: 40, y: 60, parentId: frame.id }), card('shape:paper-b', 'pmid:11', { x: 300, y: 60, parentId: frame.id })]
	// a note pinned to a kept paper goes with it; a loose one goes with the frame
	const pinned = { id: 'shape:note-pinned', type: 'note', x: 500, y: 20, parentId: frame.id, props: { text: 'mine' } }
	const loose = { id: 'shape:note-loose', type: 'note', x: 100, y: 200, parentId: frame.id }
	const { editor, fake, shapes, bindings } = fakeEditor([frame, ...inside, pinned, loose])
	bindings.set('binding:pin', { id: 'binding:pin', type: 'note-pin', fromId: pinned.id, toId: 'shape:paper-a', props: {}, meta: {} })
	const off = registerBoardSideEffects(editor, 'm_me', 'b_cluster')
	try {
		fake.deleteShapes([frame.id])
		assert.ok(!shapes.has(frame.id))
		const a = shapes.get('shape:paper-a')!
		const b = shapes.get('shape:paper-b')!
		assert.deepEqual([a.parentId, a.x, a.y], ['page:1', 440, 360])
		assert.deepEqual([b.parentId, b.x, b.y], ['page:1', 700, 360])
		assert.deepEqual([a.meta, b.meta], [{ createdBy: 'agent' }, { createdBy: 'agent' }])

		// the pinned note stayed beside its paper, still bound; the loose one went with the frame
		const note = shapes.get(pinned.id)!
		assert.deepEqual([note.parentId, note.x, note.y], ['page:1', 900, 320])
		assert.deepEqual([...bindings.keys()], ['binding:pin'])
		assert.ok(!shapes.has(loose.id))
		// the loose note's removal is a change; the rescue of the papers and the pinned note is not
		assert.deepEqual(
			changes.get('b_cluster').entries.map((e) => e.change),
			[{ type: 'note_removed', noteId: loose.id, text: '' }]
		)

		// a paper the person moves afterwards is theirs again
		fake.updateShape({ id: a.id, x: 480 })
		assert.equal(shapes.get(a.id)!.meta.pinnedByHuman, true)
		assert.deepEqual(
			changes.get('b_cluster').entries.map((e) => e.change),
			[{ type: 'note_removed', noteId: loose.id, text: '' }, { type: 'moved', paperId: 'pmid:10' }]
		)
	} finally {
		off()
	}
})
