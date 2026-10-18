// Shape IDs that the browser, the canvas MCP and the harness (harness/harness/board/ids.py) must
// agree on. Both sides are tested against fixtures/paper-ids.json.

/** Every character (code point) outside [A-Za-z0-9_-] becomes `_`. */
export function slug(id: string): string {
	return id.replace(/[^A-Za-z0-9_-]/gu, '_')
}

/** One card per paper: writing the same paper twice updates the same shape. */
export function paperShapeId(paperId: string) {
	return `shape:paper-${slug(paperId)}` as const
}

/** The paper ID a paper card's shape ID came from can't be recovered (slugs are lossy): read `props.paperId`. */
export function isPaperShapeId(id: string): boolean {
	return id.startsWith('shape:paper-')
}

export type LinkKind = 'cites' | 'similar' | 'user'

/** One link per pair and kind, so writing the same link twice is a no-op. */
export function linkShapeId(fromPaperId: string, toPaperId: string, kind: LinkKind) {
	return `shape:link-${kind}-${slug(fromPaperId)}--${slug(toPaperId)}` as const
}

/** Any other shape an agent writes, for example a note: `shape:agent-note-3f9a0c1d2e4b`. */
export function agentShapeId(kind: string) {
	return `shape:agent-${slug(kind)}-${randomHex(12)}` as const
}

/** One run per ACP prompt turn, made by the harness and sent as `X-Run-Id`. */
export const RUN_ID_PATTERN = /^run_[0-9a-f]{12}$/

export function randomHex(length: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)))
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, length)
}
