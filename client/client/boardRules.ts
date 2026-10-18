// The attribution and human-touched rules behind sideEffects.ts (T01), free of tldraw so they
// run under `node --test`.

type Meta = Record<string, unknown>

export type ChangeSource = 'user' | 'remote'

export interface ShapeLike {
	type: string
	x: number
	y: number
	rotation: number
	parentId: string
	props: object
	meta: Meta
}

/** Votes, board state and the link-driven size: a person changing these doesn't lock a paper card. */
export const PAPER_STATE_PROPS = new Set(['status', 'kind', 'keepBy', 'discardBy', 'w', 'h'])

/** A shape a person creates is theirs; agent shapes (copied or not) keep their attribution. */
export function createdMeta<M extends Meta>(meta: M, source: ChangeSource, memberId: string): M {
	if (source !== 'user' || meta.createdBy || meta.author === memberId) return meta
	return { ...meta, author: memberId }
}

/**
 * The meta an agent's shape gets when this browser's person changes it: moving it pins it,
 * editing its props marks it edited, so agents leave it alone. Remote changes (other people, the
 * agent through the server) never set flags. Returns `next.meta` itself when nothing changes.
 */
export function nextMeta<S extends ShapeLike>(prev: S, next: S, source: ChangeSource): S['meta'] {
	const meta = next.meta
	if (source !== 'user' || prev.meta.createdBy !== 'agent') return meta
	const moved =
		prev.x !== next.x || prev.y !== next.y || prev.rotation !== next.rotation || prev.parentId !== next.parentId
	const edited = changedProps(prev.props, next.props).some(
		(key) => !(next.type === 'paper-card' && PAPER_STATE_PROPS.has(key))
	)
	const pin = moved && meta.pinnedByHuman !== true
	const edit = edited && meta.editedByHuman !== true
	if (!pin && !edit) return meta
	return { ...meta, ...(pin && { pinnedByHuman: true }), ...(edit && { editedByHuman: true }) }
}

function changedProps(prev: object, next: object): string[] {
	const a = prev as Record<string, unknown>
	const b = next as Record<string, unknown>
	const keys = new Set([...Object.keys(a), ...Object.keys(b)])
	return [...keys].filter((k) => a[k] !== b[k] && JSON.stringify(a[k]) !== JSON.stringify(b[k]))
}
