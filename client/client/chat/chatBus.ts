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
