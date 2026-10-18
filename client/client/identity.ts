// Demo-grade identity (decision D5): a member ID made once per browser and trusted by the server.
const MEMBER_KEY = 'pdc.memberId'
const NAME_KEY = 'pdc.displayName'
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export function getMemberId(): string {
	let id = localStorage.getItem(MEMBER_KEY)
	if (!id?.match(/^m_[a-z0-9]{10}$/)) {
		const bytes = crypto.getRandomValues(new Uint8Array(10))
		id = 'm_' + Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
		localStorage.setItem(MEMBER_KEY, id)
	}
	return id
}

/** The name cursors and the face pile show, or null until the person has given one. */
export function getDisplayName(): string | null {
	return localStorage.getItem(NAME_KEY)?.trim() || null
}

export function setDisplayName(name: string) {
	const trimmed = name.trim().slice(0, 40)
	if (trimmed) localStorage.setItem(NAME_KEY, trimmed)
	else localStorage.removeItem(NAME_KEY)
}
