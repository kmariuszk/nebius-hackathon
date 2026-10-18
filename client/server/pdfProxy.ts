import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { slug } from '../shared/ids.ts'
import { assertPublicUrl } from './netGuard.ts'

// Open-access PDFs for the paper widgets (T10), proxied because publishers don't send CORS headers.
// The link comes from paper metadata, so it is untrusted: https only, public addresses only (checked
// again on every redirect, at most 3), `%PDF` magic bytes, 50 MB at most. Cached under DATA_DIR/pdfs.

export const MAX_PDF_BYTES = 50 * 1024 * 1024
const MAX_REDIRECTS = 3
const TIMEOUT_MS = 60_000

let pdfDir = join(resolve(process.env.DATA_DIR ?? '.data'), 'pdfs')

/** Tests point the cache at a temp dir. */
export function setPdfDir(dir: string) {
	pdfDir = dir
}

/** `refused`: the link itself isn't allowed (scheme, address); otherwise fetching it failed. */
export class PdfError extends Error {
	refused: boolean
	constructor(message: string, refused = false) {
		super(message)
		this.refused = refused
	}
}

/** Throws a refused PdfError unless the URL is https on a public address. */
export async function checkPdfUrl(url: URL) {
	if (url.protocol !== 'https:') throw new PdfError(`Only https PDF links are fetched, not ${url.protocol}`, true)
	try {
		await assertPublicUrl(url)
	} catch (e) {
		throw new PdfError(e instanceof Error ? e.message : String(e), true)
	}
}

export interface FetchPdfOptions {
	/** Run on the link and every redirect; tests swap it to reach a local server. */
	check?: (url: URL) => Promise<void>
	maxBytes?: number
}

export async function fetchPdf(link: string, { check = checkPdfUrl, maxBytes = MAX_PDF_BYTES }: FetchPdfOptions = {}) {
	let url: URL
	try {
		url = new URL(link)
	} catch {
		throw new PdfError(`Not a URL: ${link.slice(0, 200)}`, true)
	}
	const signal = AbortSignal.timeout(TIMEOUT_MS)
	for (let hop = 0; ; hop++) {
		await check(url)
		let res: Response
		try {
			res = await fetch(url, { redirect: 'manual', signal, headers: { accept: 'application/pdf' } })
		} catch (e) {
			throw new PdfError(`Couldn't fetch ${url.host}: ${e instanceof Error ? e.message : e}`)
		}
		const location = res.headers.get('location')
		if (res.status >= 300 && res.status < 400 && location) {
			await res.body?.cancel()
			if (hop >= MAX_REDIRECTS) throw new PdfError(`More than ${MAX_REDIRECTS} redirects`)
			url = new URL(location, url)
			continue
		}
		if (!res.ok) {
			await res.body?.cancel()
			throw new PdfError(`${url.host} answered ${res.status}`)
		}
		if (Number(res.headers.get('content-length')) > maxBytes) {
			await res.body?.cancel()
			throw new PdfError(`The PDF is larger than ${maxBytes} bytes`)
		}
		const pdf = await readCapped(res, maxBytes, url)
		if (!pdf.subarray(0, 1024).includes('%PDF-')) throw new PdfError(`${url.host} didn't send a PDF`)
		return pdf
	}
}

async function readCapped(res: Response, maxBytes: number, url: URL): Promise<Buffer> {
	const reader = res.body?.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	try {
		for (let read = await reader?.read(); read && !read.done; read = await reader!.read()) {
			size += read.value.length
			if (size > maxBytes) {
				await reader!.cancel()
				throw new PdfError(`The PDF is larger than ${maxBytes} bytes`)
			}
			chunks.push(read.value)
		}
	} catch (e) {
		if (e instanceof PdfError) throw e
		throw new PdfError(`Couldn't read the PDF from ${url.host}: ${e instanceof Error ? e.message : e}`)
	}
	return Buffer.concat(chunks)
}

// slugs are lossy, so a short hash of the paper ID keeps two papers from sharing a file
const cacheFile = (paperId: string) =>
	join(pdfDir, `${slug(paperId).slice(0, 100)}-${createHash('sha256').update(paperId).digest('hex').slice(0, 8)}.pdf`)

/**
 * Sends the paper's PDF, fetching it from `link()` and caching it the first time. Throws (a PdfError
 * for the PDF itself) before writing anything.
 */
export async function servePdf(res: ServerResponse, paperId: string, link: () => Promise<string>, options?: FetchPdfOptions) {
	const file = cacheFile(paperId)
	if (!existsSync(file)) {
		const pdf = await fetchPdf(await link(), options)
		mkdirSync(pdfDir, { recursive: true })
		// written aside and renamed, so a half-written file is never served
		const part = `${file}.${randomBytes(4).toString('hex')}.part`
		writeFileSync(part, pdf)
		renameSync(part, file)
	}
	res.writeHead(200, {
		'content-type': 'application/pdf',
		'content-length': statSync(file).size,
		'cache-control': 'private, max-age=86400',
		'content-security-policy': "default-src 'none'",
		'x-content-type-options': 'nosniff',
	})
	await pipeline(createReadStream(file), res)
}
