import type { StopReason } from '@agentclientprotocol/sdk'

// Pure display helpers for the chat panel, kept apart from React so they run under node --test.

/** "nvidia/Nemotron-3_5-Lightning" → "Nemotron 3.5 Lightning" */
export function modelLabel(model: string): string {
	return (model.split('/').pop() ?? model)
		.replace(/(\d)_(\d)/g, '$1.$2')
		.replace(/[-_]+/g, ' ')
		.trim()
}

export function formatSeconds(s: number): string {
	return `${s < 10 ? Math.round(s * 10) / 10 : Math.round(s)} s`
}

export function formatCost(amount: number, currency = 'USD'): string {
	if (currency !== 'USD') return `${amount.toFixed(2)} ${currency}`
	if (amount > 0 && amount < 0.01) return '<$0.01'
	return `$${amount.toFixed(2)}`
}

export function formatTokens(n: number): string {
	if (n < 1000) return String(n)
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
	return `${(n / 1_000_000).toFixed(1)}M`
}

/** v4's per-step line from a tool card's `_meta`: "Nemotron 3.5 Super VL · 6.2 s · $0.01". */
export function toolMetaLine(meta: Record<string, unknown>): string {
	const parts: string[] = []
	if (typeof meta.model === 'string' && meta.model) parts.push(modelLabel(meta.model))
	if (typeof meta.seconds === 'number') parts.push(formatSeconds(meta.seconds))
	if (typeof meta.costUsd === 'number' && meta.costUsd > 0) parts.push(formatCost(meta.costUsd))
	return parts.join(' · ')
}

/** A short line for turns that ended other than normally; null when there's nothing to say. */
export function stopReasonText(reason: StopReason | null): string | null {
	switch (reason) {
		case 'cancelled':
			return 'Stopped'
		case 'max_tokens':
			return 'The answer was cut off: it reached the length limit.'
		case 'max_turn_requests':
			return 'The agent stopped: it reached its step limit for one turn.'
		case 'refusal':
			return 'The agent declined to answer this.'
		default:
			return null
	}
}

export function prettyJson(value: unknown): string {
	if (value === undefined) return ''
	if (typeof value === 'string') return value
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

const PAPER_KEYS = new Set(['added', 'updated', 'paperId', 'paperIds'])

/**
 * Papers and shapes a tool's output names, for "Show on board": `added`/`updated` paper IDs, any
 * `shape:` ID, including inside an MCP result's JSON text. Skipped entries weren't written, so
 * they don't count.
 */
export function findBoardTargets(output: unknown): { paperIds: string[]; shapeIds: string[] } {
	const paperIds = new Set<string>()
	const shapeIds = new Set<string>()
	const visit = (value: unknown, key: string, depth: number) => {
		if (depth > 8 || value == null) return
		if (typeof value === 'string') {
			if (value.startsWith('shape:')) shapeIds.add(value)
			else if (PAPER_KEYS.has(key)) paperIds.add(value)
			else if (key === 'text' && /^\s*[[{]/.test(value)) {
				try {
					visit(JSON.parse(value), '', depth + 1)
				} catch {
					// not JSON after all
				}
			}
			return
		}
		if (Array.isArray(value)) return value.forEach((v) => visit(v, key, depth + 1))
		if (typeof value === 'object') {
			for (const [k, v] of Object.entries(value)) if (k !== 'skipped') visit(v, k, depth + 1)
		}
	}
	visit(output, '', 0)
	return { paperIds: [...paperIds], shapeIds: [...shapeIds] }
}
