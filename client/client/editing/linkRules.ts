import type { LinkKind } from '../../shared/ids.ts'

// The link editor's rules (T14), free of React and tldraw so they run under `node --test`:
// what each kind of link offers, the meta each edit writes, and the editor's wording, from the v6
// demo board. A citation is a PubMed fact (label or hide it, the citation stays in the data);
// a similar link is the agent's guess (rename, hide or delete it); your own links are yours.

type Meta = Record<string, unknown>

export const kindOf = (meta: Meta): LinkKind =>
	meta.kind === 'cites' || meta.kind === 'similar' ? meta.kind : 'user'

export interface LinkOptions {
	hide: boolean
	delete: boolean
	/** Deleting it also goes to the board service's removed links, so the agent never draws it again. */
	recordRemoved: boolean
}

/** Every kind can be labelled; what else the editor offers. */
export function linkOptions(kind: LinkKind): LinkOptions {
	if (kind === 'cites') return { hide: true, delete: false, recordRemoved: false }
	if (kind === 'similar') return { hide: true, delete: true, recordRemoved: true }
	return { hide: true, delete: true, recordRemoved: false }
}

/** A person's label: shown to everyone, and the canvas MCP never relabels the link again. */
export function labelledMeta<M extends Meta>(meta: M, label: string, memberId: string): M {
	return { ...meta, label, labelBy: memberId, editedByHuman: true }
}

/** Hidden for everyone; the canvas MCP never unhides it. */
export function hiddenMeta<M extends Meta>(meta: M): M {
	return { ...meta, hiddenByHuman: true, editedByHuman: true }
}

/** The pill on a string: your label (with "cites" after it on a citation), else the kind. */
export function linkTag(kind: LinkKind, label: string): string {
	if (label) return kind === 'cites' ? `${label} · cites` : label
	return kind === 'user' ? 'linked' : kind
}

export const LINK_SUGGESTIONS = ['builds on', 'contradicts', 'same method', 'same cohort', 'compare with']

/** The line under the label: where the link comes from and what a label does to it. */
export function linkNote(kind: LinkKind, from: string, to: string, by: unknown, memberId: string): string {
	if (kind === 'cites') {
		const source = by === 'openalex' ? 'OpenAlex' : 'PubMed'
		return `From ${source}: ${from} cites ${to}. Your label is added next to “cites”.`
	}
	if (kind === 'similar') return 'The agent found similar abstracts. Your label replaces “similar”.'
	return `Drawn by ${by === memberId ? 'you' : 'a teammate'}.`
}

export function hiddenToast(kind: LinkKind): string {
	return kind === 'cites' ? 'Link hidden. The citation stays in the data, just not on this board.' : 'Link hidden.'
}

export const DELETED_TOAST = 'Link deleted.'
