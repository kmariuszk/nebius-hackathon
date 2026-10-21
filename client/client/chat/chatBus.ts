import type { ContentBlock } from '@agentclientprotocol/sdk'

// The one way the rest of the app talks to the agent (T05): "Find more like this", the Start
// page's first prompt, "Update suggestions". The chat panel takes each request, opens itself and
// sends it once the connection is ready; a request made before any panel listens waits here.

export interface AskRequest {
	text: string
	/** Extra ACP `resource` blocks after the text, e.g. T13's tldraw://<boardId>/changes. */
	resources?: { uri: string; mimeType: string; text: string }[]
}

type AskHandler = (request: AskRequest) => void

export function createChatBus() {
	const queue: AskRequest[] = []
	let handler: AskHandler | null = null
	return {
		/** Hands the request to the panel, or keeps it until one subscribes. */
		ask(request: AskRequest) {
			if (handler) handler(request)
			else queue.push(request)
		},
		/** One panel at a time; each request reaches exactly one handler, once. Returns the unsubscribe function. */
		onAsk(next: AskHandler) {
			handler = next
			for (const request of queue.splice(0)) next(request)
			return () => {
				if (handler === next) handler = null
			}
		},
	}
}

export const chatBus = createChatBus()

/** The prompt's blocks: the text, then each resource as an embedded `resource` block. */
export function promptBlocks({ text, resources = [] }: AskRequest): ContentBlock[] {
	return [{ type: 'text', text }, ...resources.map((resource): ContentBlock => ({ type: 'resource', resource }))]
}

// ---- turns ending, for whoever asked (T13's "Done. The agent caught up with your changes.")

/** A prompt turn that stopped running: its key in the chat, its prompt and how it stopped. */
export interface TurnEnd {
	key: string
	prompt: string | null
	stopReason: string | null
}

type TurnLike = { key: string; prompt: string | null; running: boolean; stopReason: string | null }

export function createTurnBus() {
	const listeners = new Set<(end: TurnEnd) => void>()
	let show: ((key: string) => void) | null = null
	return {
		/** The chat panel reports each turn that ends. */
		ended(end: TurnEnd) {
			for (const listener of [...listeners]) listener(end)
		},
		onEnded(listener: (end: TurnEnd) => void) {
			listeners.add(listener)
			return () => void listeners.delete(listener)
		},
		/** Opens the chat scrolled to a turn ("See what it did"). */
		show(key: string) {
			show?.(key)
		},
		/** One panel at a time. Returns the unsubscribe function. */
		onShow(next: (key: string) => void) {
			show = next
			return () => {
				if (show === next) show = null
			}
		},
	}
}

export const chatTurns = createTurnBus()

/** Turns that were running before and have stopped now. */
export function endedTurns(before: readonly TurnLike[], after: readonly TurnLike[]): TurnEnd[] {
	const running = new Set(before.filter((t) => t.running).map((t) => t.key))
	return after
		.filter((t) => running.has(t.key) && !t.running)
		.map((t) => ({ key: t.key, prompt: t.prompt, stopReason: t.stopReason }))
}
