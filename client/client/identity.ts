// Demo-grade identity (decision D5): a member ID made once per browser and trusted by the server.
const MEMBER_KEY = 'pdc.memberId'
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
