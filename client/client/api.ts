import type { PaperStatus } from '../shared/paperCard.ts'

// The board service's REST API (T08) from the browser: JSON in and out, the member ID as the
// bearer (decision D5). Routes and shapes are in the root README.

export class ApiError extends Error {
	status: number
	code: string
	constructor(status: number, code: string, message: string) {
		super(message)
		this.status = status
		this.code = code
	}
}

export interface Member {
	memberId: string
	displayName: string
	lastSeenSeq: number
	joinedAt: string
}

export interface VoteResult {
	status: PaperStatus
	keepBy: string[]
	discardBy: string[]
}

async function call<T>(method: string, path: string, memberId: string, body?: unknown): Promise<T> {
	const res = await fetch(`/api/v1${path}`, {
		method,
		headers: { authorization: `Bearer ${memberId}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	if (res.status === 204) return undefined as T
	const data = await res.json().catch(() => null)
	if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `The board service answered ${res.status}`)
	return data as T
}

/** One board's routes, as one member. */
export function boardApi(boardId: string, memberId: string) {
	const board = `/boards/${encodeURIComponent(boardId)}`
	return {
		/** Join the board; with a name, also set the name the others see. */
		join: (displayName?: string) => call<Member>('PUT', `${board}/members/me`, memberId, { displayName }),
		/** Keep, Discard, or (null) take the vote back; the card updates for everyone through sync. */
		vote: (paperId: string, decision: 'keep' | 'discard' | null) =>
			call<VoteResult>('PUT', `${board}/papers/${encodeURIComponent(paperId)}/vote`, memberId, { decision }),
	}
}
