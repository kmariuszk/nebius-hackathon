import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fadeCss, relatedSet, type BindingLite, type ShapeLite } from './fade.ts'

const open = 'shape:paper-n1'
const shapes: Record<string, ShapeLite> = {
	[open]: { type: 'paper-card' },
	'shape:paper-s1': { type: 'paper-card' },
	'shape:paper-s2': { type: 'paper-card' },
	'shape:paper-k1': { type: 'paper-card' },
	'shape:paper-far': { type: 'paper-card' },
	'shape:link-cites-n1--s1': { type: 'arrow', meta: { kind: 'cites', label: '', hiddenByHuman: false } },
	'shape:link-cites-s2--n1': { type: 'arrow', meta: { kind: 'cites', label: 'builds on', hiddenByHuman: false } },
	'shape:link-similar-n1--k1': { type: 'arrow', meta: { kind: 'similar', label: '', hiddenByHuman: true } },
	'shape:link-cites-s1--far': { type: 'arrow', meta: { kind: 'cites', label: '', hiddenByHuman: false } },
	'shape:arrow-to-note': { type: 'arrow' },
	'shape:note-a': { type: 'note' },
	'shape:note-b': { type: 'note' },
}
const arrow = (arrowId: string, start: string, end: string): BindingLite[] => [
	{ id: `binding:${arrowId}-s`, type: 'arrow', fromId: arrowId, toId: start, props: { terminal: 'start' } },
	{ id: `binding:${arrowId}-e`, type: 'arrow', fromId: arrowId, toId: end, props: { terminal: 'end' } },
]
const bindings: BindingLite[] = [
	...arrow('shape:link-cites-n1--s1', open, 'shape:paper-s1'),
	...arrow('shape:link-cites-s2--n1', 'shape:paper-s2', open),
	...arrow('shape:link-similar-n1--k1', open, 'shape:paper-k1'),
	...arrow('shape:link-cites-s1--far', 'shape:paper-s1', 'shape:paper-far'),
	...arrow('shape:arrow-to-note', open, 'shape:note-b'),
	// duplicates are fine (the browser gathers bindings from both ends)
	...arrow('shape:link-cites-n1--s1', open, 'shape:paper-s1'),
	{ id: 'binding:pin-a', type: 'note-pin', fromId: 'shape:note-a', toId: open, props: { dx: 10, dy: 0 } },
	{ id: 'binding:pin-b', type: 'note-pin', fromId: 'shape:note-b', toId: 'shape:paper-s1', props: { dx: 0, dy: 0 } },
]
const shapeOf = (id: string) => shapes[id]

test('links both ways, with direction, kind and label', () => {
	const { links } = relatedSet(open, bindings, shapeOf)
	const byId = Object.fromEntries(links.map((l) => [l.id, l]))
	assert.deepEqual(byId['shape:link-cites-n1--s1'], {
		id: 'shape:link-cites-n1--s1',
		other: 'shape:paper-s1',
		dir: 'out',
		kind: 'cites',
		label: '',
	})
	assert.deepEqual(byId['shape:link-cites-s2--n1'], {
		id: 'shape:link-cites-s2--n1',
		other: 'shape:paper-s2',
		dir: 'in',
		kind: 'cites',
		label: 'builds on',
	})
	// an arrow a person drew to a note has no link meta
	assert.equal(byId['shape:arrow-to-note'].kind, 'user')
	assert.equal(links.length, 3)
})

test('papers are only the paper cards at the other ends', () => {
	assert.deepEqual(relatedSet(open, bindings, shapeOf).papers.sort(), ['shape:paper-s1', 'shape:paper-s2'])
})

test('hidden links and links between other papers are left out', () => {
	const { links, papers } = relatedSet(open, bindings, shapeOf)
	assert.ok(!links.some((l) => l.id === 'shape:link-similar-n1--k1'))
	assert.ok(!papers.includes('shape:paper-k1'))
	assert.ok(!links.some((l) => l.id === 'shape:link-cites-s1--far'))
	assert.ok(!papers.includes('shape:paper-far'))
})

test('notes pinned to the open paper, not to its neighbours', () => {
	assert.deepEqual(relatedSet(open, bindings, shapeOf).notes, ['shape:note-a'])
})

test('a dangling arrow (one end unbound) links to nothing', () => {
	const dangling: BindingLite[] = [
		{ id: 'binding:d', type: 'arrow', fromId: 'shape:d', toId: open, props: { terminal: 'start' } },
	]
	assert.deepEqual(relatedSet(open, dangling, shapeOf), { links: [], papers: [], notes: [] })
})

test('the style rule fades everything but the open paper, keeps related shapes dimmer, lit ones full', () => {
	const css = fadeCss(open, ['shape:paper-s1', open], ['shape:paper-s2'])
	assert.match(css, /\.tl-shape:not\(\[data-shape-id="shape:paper-n1"\]\)\{opacity:0\.1!important\}/)
	assert.match(css, /\.tl-shape:is\(\[data-shape-id="shape:paper-s1"\]\)\{opacity:0\.35!important\}/)
	assert.match(css, /\.tl-shape:is\(\[data-shape-id="shape:paper-s2"\]\)\{opacity:1!important\}/)
	// the lit rule comes after the related rule, so it wins at equal specificity
	assert.ok(css.indexOf('opacity:1!') > css.indexOf('opacity:0.35!'))
})

test('the style rule escapes quotes in IDs and skips empty groups', () => {
	const css = fadeCss('shape:a"b', [])
	assert.ok(css.includes('[data-shape-id="shape:a\\"b"]'))
	assert.ok(!css.includes(':is('))
})
