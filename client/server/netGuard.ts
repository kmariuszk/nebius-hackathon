import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

// URLs that come from users (pasted bookmarks, paper links) must never make the server
// request itself, the cloud metadata service or anything else on a private network.
// BlockList also checks IPv4-mapped IPv6 addresses (::ffff:127.0.0.1) against the IPv4 rules.
const blocked = new BlockList()
for (const [net, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['224.0.0.0', 4],
	['240.0.0.0', 4],
] as const) {
	blocked.addSubnet(net, prefix, 'ipv4')
}
for (const [net, prefix] of [
	['::', 128],
	['::1', 128],
	['fc00::', 7],
	['fe80::', 10],
	['ff00::', 8],
] as const) {
	blocked.addSubnet(net, prefix, 'ipv6')
}

export async function assertPublicUrl(url: URL) {
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`Blocked protocol ${url.protocol}`)
	}
	const host = url.hostname.replace(/^\[|\]$/g, '')
	const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true })
	for (const { address } of addresses) {
		if (blocked.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')) {
			throw new Error(`Blocked private address ${address} for ${url.hostname}`)
		}
	}
}

// fetch that checks the address of every hop in a redirect chain, not just the first URL
export async function publicFetch(input: string, init: RequestInit = {}, maxRedirects = 3) {
	let url = new URL(input)
	for (let hop = 0; ; hop++) {
		await assertPublicUrl(url)
		const res = await fetch(url, {
			...init,
			redirect: 'manual',
			signal: init.signal ?? AbortSignal.timeout(5000),
		})
		const location = res.headers.get('location')
		if (res.status < 300 || res.status >= 400 || !location) return res
		if (hop >= maxRedirects) throw new Error(`More than ${maxRedirects} redirects`)
		url = new URL(location, url)
	}
}
