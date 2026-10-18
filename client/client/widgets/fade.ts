import { PAPER_CARD_TYPE } from '../../shared/paperCard.ts'

// Opening a paper fades the rest of the board in this browser only (decision D19): a generated
// style rule keyed on the `data-shape-id` attribute that tldraw 5.5 puts on every shape wrapper
// (DefaultShapeWrapper). tldraw sets the wrapper's opacity inline, hence `!important`.

export interface BindingLite {
	id: string
	type: string
	fromId: string
	toId: string
	props?: object
}

export interface ShapeLite {
	type: string
	meta?: Record<string, unknown>
}

export interface RelatedLink {
	/** The arrow's shape ID. */
	id: string
	/** The shape at the arrow's other end. */
	other: string
	/** `in`: the arrow points at the open paper ("cites it"); `out`: away from it ("cited by it"). */
	dir: 'in' | 'out'
	kind: string
	label: string
}

export interface Related {
	links: RelatedLink[]
	/** Paper cards at the other end of those links. */
	papers: string[]
	/** Notes pinned to the open paper. */
	notes: string[]
}

/**
 * What the open paper is linked to: arrows bound to it in either direction (unless a person hid
 * them), the paper cards at their other ends, and the notes pinned to it. `bindings` may hold
 * duplicates and unrelated bindings.
 */
export function relatedSet(
	openId: string,
	bindings: BindingLite[],
	shapeOf: (id: string) => ShapeLite | undefined,
	pinType = 'note-pin'
): Related {
	const arrows = new Map<string, { start?: string; end?: string }>()
	const notes = new Set<string>()
	for (const b of bindings) {
		if (b.type === 'arrow') {
			const terminal = (b.props as { terminal?: string } | undefined)?.terminal
			if (terminal !== 'start' && terminal !== 'end') continue
			const ends = arrows.get(b.fromId) ?? {}
			ends[terminal] = b.toId
			arrows.set(b.fromId, ends)
		} else if (b.type === pinType && b.toId === openId) notes.add(b.fromId)
	}

	const links: RelatedLink[] = []
	for (const [id, { start, end }] of arrows) {
		if (start !== openId && end !== openId) continue
		const other = start === openId ? end : start
		if (!other || other === openId) continue
		const meta = shapeOf(id)?.meta ?? {}
		if (meta.hiddenByHuman === true) continue
		links.push({
			id,
			other,
			dir: end === openId ? 'in' : 'out',
			kind: typeof meta.kind === 'string' ? meta.kind : 'user',
			label: typeof meta.label === 'string' ? meta.label : '',
		})
	}
	const papers = [...new Set(links.map((l) => l.other))].filter((id) => shapeOf(id)?.type === PAPER_CARD_TYPE)
	return { links, papers, notes: [...notes] }
}

const attr = (id: string) => `[data-shape-id="${id.replace(/["\\]/g, '\\$&')}"]`

export const FADED = 0.1
export const RELATED = 0.35

/**
 * The style rule: everything but the open paper drops to FADED, what it's linked to stays a
 * little more visible, and `lit` shapes (a peek at the seeds) come back fully.
 */
export function fadeCss(openId: string, related: string[], lit: string[] = []): string {
	const rules = [
		'.tl-shape{transition:opacity .25s}',
		`.tl-shape:not(${attr(openId)}){opacity:${FADED}!important}`,
	]
	const rel = related.filter((id) => id !== openId)
	if (rel.length) rules.push(`.tl-shape:is(${rel.map(attr).join(',')}){opacity:${RELATED}!important}`)
	const on = lit.filter((id) => id !== openId)
	if (on.length) rules.push(`.tl-shape:is(${on.map(attr).join(',')}){opacity:1!important}`)
	return rules.join('\n')
}
