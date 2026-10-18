import type { LinkKind } from './ids.ts'

// What `meta` says on board shapes (group README, Shared contracts). Agents write AgentMeta through
// the canvas MCP; the browser writes PersonMeta and the human-touched flags.

export interface AgentMeta {
	createdBy: 'agent'
	/** The member the agent works for. */
	onBehalfOf: string
	runId: string | null
	paperId?: string
	/** Written by an external agent through a personal token (T11). */
	via?: 'external'
}

export interface PersonMeta {
	/** Member ID, set by the browser when a person creates the shape. */
	author: string
}

export interface HumanTouched {
	/** A person moved it: agents never change its position or parent again. */
	pinnedByHuman?: boolean
	/** A person edited its props: agents never change its props again. */
	editedByHuman?: boolean
}

/** Meta on the built-in arrows that link two paper cards. */
export interface LinkMeta {
	kind: LinkKind
	/** Text a person wrote, or empty. */
	label: string
	/** "agent", "pubmed" or a member ID. */
	by: string
	hiddenByHuman: boolean
}

/** Meta on the built-in frames that hold a cluster (T02 phase 2). */
export interface ClusterMeta {
	clusterId: string
	labelGenerated: boolean
	renamedByHuman: boolean
}

type Meta = Record<string, unknown> | undefined

export const isAgentShape = (meta: Meta) => meta?.createdBy === 'agent'
export const isHumanTouched = (meta: Meta) => meta?.pinnedByHuman === true || meta?.editedByHuman === true
