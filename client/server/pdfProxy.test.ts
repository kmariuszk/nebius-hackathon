// The PDF proxy against a local HTTP server: node --test server/pdfProxy.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fetchPdf, PdfError, servePdf, setPdfDir } from './pdfProxy.ts'

const PDF = Buffer.from('%PDF-1.4\n% a tiny test file\n%%EOF\n')
const dir = mkdtempSync(join(tmpdir(), 'pdf-proxy-'))
setPdfDir(dir)

let http: Server
let base = ''
let hits = 0

before(async () => {
	http = createServer((req, res) => {
		hits++
		const path = req.url ?? '/'
		if (path === '/paper.pdf') return res.writeHead(200, { 'content-type': 'application/pdf' }).end(PDF)
		if (path === '/page') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html>Sign in to read</html>')
		if (path === '/big.pdf') return res.writeHead(200).end(Buffer.concat([PDF, Buffer.alloc(2000)]))
		if (path === '/moved') return res.writeHead(302, { location: '/paper.pdf' }).end()
		if (path === '/to-secret') return res.writeHead(302, { location: '/secret' }).end()
		if (path === '/loop') return res.writeHead(302, { location: '/loop' }).end()
		res.writeHead(404).end()
	})
	await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
	base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
})

after(async () => {
	await new Promise((resolve) => http.close(resolve))
	rmSync(dir, { recursive: true, force: true })
})

// the local server is on a private address, so these tests swap the check for one that lets it through
const local = async () => {}
const refused = (pattern: RegExp) => (e: unknown) => e instanceof PdfError && e.refused && pattern.test(e.message)
const failed = (pattern: RegExp) => (e: unknown) => e instanceof PdfError && !e.refused && pattern.test(e.message)

test('fetches a PDF, following redirects', async () => {
	assert.deepEqual(await fetchPdf(`${base}/paper.pdf`, { check: local }), PDF)
	assert.deepEqual(await fetchPdf(`${base}/moved`, { check: local }), PDF)
})

test('refuses http, file: and private addresses, on the first hop and every redirect', async () => {
	await assert.rejects(fetchPdf('http://127.0.0.1/paper.pdf'), refused(/Only https/))
	await assert.rejects(fetchPdf('file:///etc/passwd'), refused(/Only https/))
	await assert.rejects(fetchPdf('not a url'), refused(/Not a URL/))
	const port = (http.address() as AddressInfo).port
	await assert.rejects(fetchPdf(`https://localhost:${port}/paper.pdf`), refused(/Blocked private address/))
	const noSecrets = async (url: URL) => {
		if (url.pathname === '/secret') throw new PdfError('Blocked /secret', true)
	}
	await assert.rejects(fetchPdf(`${base}/to-secret`, { check: noSecrets }), refused(/Blocked \/secret/))
})

test('refuses what isn’t a PDF, a redirect loop and a file over the cap', async () => {
	await assert.rejects(fetchPdf(`${base}/page`, { check: local }), failed(/didn't send a PDF/))
	await assert.rejects(fetchPdf(`${base}/loop`, { check: local }), failed(/More than 3 redirects/))
	await assert.rejects(fetchPdf(`${base}/big.pdf`, { check: local, maxBytes: 1000 }), failed(/larger than 1000 bytes/))
	await assert.rejects(fetchPdf(`${base}/gone.pdf`, { check: local }), failed(/answered 404/))
})

test('servePdf caches the file and sends it with a CSP that runs nothing', async () => {
	const proxy = createServer((_req, res) =>
		servePdf(res, 'doi:10.1/x', async () => `${base}/paper.pdf`, { check: local }).catch((e) => res.writeHead(502).end(String(e)))
	)
	await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
	const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/`
	const before = hits
	for (let i = 0; i < 2; i++) {
		const res = await fetch(url)
		assert.equal(res.status, 200)
		assert.equal(res.headers.get('content-type'), 'application/pdf')
		assert.equal(res.headers.get('content-security-policy'), "default-src 'none'")
		assert.deepEqual(Buffer.from(await res.arrayBuffer()), PDF)
	}
	assert.equal(hits - before, 1, 'the second request comes from the cache')
	await new Promise((resolve) => proxy.close(resolve))
})
