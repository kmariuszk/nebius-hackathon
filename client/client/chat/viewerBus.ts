import type { FocusParams, HighlightParams, TourParams } from '../../shared/acpExt.ts'

// What the agent (over `_canvas/*`) and local clicks (paper links, "Show on board") ask this
// viewer's canvas to do. viewerActions.ts carries it out; nothing here touches the shared room.

type Local<T> = Omit<T, 'sessionId'>

export interface ViewerEvents {
	focus: Local<FocusParams>
	highlight: Local<HighlightParams>
	open_paper: { paperId: string }
	tour: Local<TourParams>
	/** Short feedback shown in the chat panel, for example when a paper isn't on the board. */
	notice: { text: string }
}

type Handler = (payload: never) => void
const handlers = new Map<keyof ViewerEvents, Set<Handler>>()

export const viewerBus = {
	emit<K extends keyof ViewerEvents>(type: K, payload: ViewerEvents[K]) {
		for (const handler of handlers.get(type) ?? []) {
			try {
				;(handler as (p: ViewerEvents[K]) => void)(payload)
			} catch (e) {
				console.error(`[viewerBus] ${type} handler failed:`, e)
			}
		}
	},
	/** Returns the unsubscribe function. */
	on<K extends keyof ViewerEvents>(type: K, handler: (payload: ViewerEvents[K]) => void) {
		let set = handlers.get(type)
		if (!set) handlers.set(type, (set = new Set()))
		set.add(handler)
		return () => void set.delete(handler)
	},
}
