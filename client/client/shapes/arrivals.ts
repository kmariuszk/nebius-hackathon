// Papers visibly arrive one at a time: sideEffects.ts notes every paper card the room gains after
// load, and its node fades and scales in on its turn, even when the agent writes several at once.
const STAGGER_MS = 220
const MAX_WAIT_MS = 3000
const arrivals = new Map<string, number>() // shape id → when its animation starts
let lastStart = 0

export function noteArrival(id: string) {
	const now = Date.now()
	lastStart = Math.min(Math.max(now, lastStart + STAGGER_MS), now + MAX_WAIT_MS)
	arrivals.set(id, lastStart)
	for (const [key, start] of arrivals) if (start < now - 5000) arrivals.delete(key)
}

/** How long until this node's arrival animation starts; null if it isn't arriving now. */
export function arrivalDelay(id: string): number | null {
	const start = arrivals.get(id)
	if (start === undefined) return null
	const delay = start - Date.now()
	// a node remounted later (scrolled back into view) doesn't arrive again
	return delay > -400 ? Math.max(0, delay) : null
}
