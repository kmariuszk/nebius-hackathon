import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// PDFs dropped on the Start page (T16): what to look the paper up by, from the text of its first two
// pages: the first DOI, else its title (the PDF's metadata title, or the largest line on page 1).
// pdfjs-dist is heavy, so it is loaded on the first PDF only. The PDF is kept with the uploads.

export const MAX_SEED_PDF_BYTES = 20 * 1024 * 1024
const PAGES = 2
const DOI = /10\.\d{4,9}\/[^\s"<>]+/

let uploadsDir = join(resolve(process.env.DATA_DIR ?? '.data'), 'uploads')

/** Tests point the uploads at a temp dir. */
export function setUploadsDir(dir: string) {
	uploadsDir = dir
}

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
let pdfjs: Promise<Pdfjs> | null = null
// the legacy build is the one that runs in Node
const loadPdfjs = () => (pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs'))

/** The first DOI in the text, without the sentence's punctuation after it. */
export function findDoi(text: string): string | null {
	let doi = text.match(DOI)?.[0]
	if (!doi) return null
	const count = (c: string) => doi!.split(c).length - 1
	for (;;) {
		const last = doi.at(-1)!
		// a closing bracket is part of the DOI only when it closes one opened inside it
		if (/[.,;:'"’”]/.test(last) || (last === ')' && count(')') > count('(')) || (last === ']' && count(']') > count('['))) {
			doi = doi.slice(0, -1)
		} else return doi
	}
}

interface Line {
	text: string
	size: number
}

/** The text of the first pages, line by line, and the metadata title. Throws if it isn't a PDF. */
export async function readPdf(data: Uint8Array): Promise<{ pages: Line[][]; title: string }> {
	const { getDocument, VerbosityLevel } = await loadPdfjs()
	// pdfjs takes ownership of the buffer it is given, so it gets a copy
	const task = getDocument({ data: new Uint8Array(data), verbosity: VerbosityLevel.ERRORS })
	try {
		const doc = await task.promise
		const pages: Line[][] = []
		for (let n = 1; n <= Math.min(PAGES, doc.numPages); n++) {
			const lines: Line[] = [{ text: '', size: 0 }]
			for (const item of (await (await doc.getPage(n)).getTextContent()).items) {
				if (!('str' in item)) continue
				const line = lines[lines.length - 1]
				line.text += item.str
				if (item.str.trim()) line.size = Math.max(line.size, item.height || Math.abs(item.transform[3]))
				if (item.hasEOL) lines.push({ text: '', size: 0 })
			}
			pages.push(lines.map((l) => ({ text: l.text.replace(/\s+/g, ' ').trim(), size: l.size })).filter((l) => l.text))
		}
		const { info, metadata } = await doc.getMetadata()
		const title = (info as { Title?: unknown }).Title
		return { pages, title: (typeof title === 'string' && title.trim()) || metadata?.get('dc:title') || '' }
	} finally {
		await task.destroy()
	}
}

// metadata titles are often a file name or a typesetter's placeholder
const placeholder = (title: string) => !/\S+\s+\S+\s+\S+/.test(title) || /^(microsoft word|untitled)\b|\.(docx?|pdf|tex)$/i.test(title)

/** What to look the paper up by: the first DOI, and the title for when there's none (or it's unknown). */
export async function pdfSeed(data: Uint8Array): Promise<{ doi: string | null; title: string | null }> {
	const { pages, title } = await readPdf(data)
	const doi = findDoi(pages.flat().map((l) => l.text).join('\n'))
	if (title && !placeholder(title)) return { doi, title: title.trim().slice(0, 300) }
	// the largest text on page 1, with the lines it wraps onto
	const first = (pages[0] ?? []).filter((l) => l.text.length >= 3)
	const largest = Math.max(0, ...first.map((l) => l.size))
	const start = first.findIndex((l) => l.size === largest)
	let end = start + 1
	while (start >= 0 && end < first.length && Math.abs(first[end].size - largest) < 0.5) end++
	const text = first
		.slice(Math.max(start, 0), end)
		.map((l) => l.text)
		.join(' ')
	return { doi, title: text.length >= 10 ? text.slice(0, 300) : null }
}

/** Keeps the PDF with the uploads (server.ts serves it at /api/uploads/<id>); returns its upload ID. */
export function savePdf(data: Uint8Array): string {
	const id = `pdf-${createHash('sha256').update(data).digest('hex').slice(0, 24)}`
	const file = join(uploadsDir, id)
	if (existsSync(`${file}.type`)) return id
	mkdirSync(uploadsDir, { recursive: true })
	// written aside and renamed, and the .type marker last, so a half-written file is never served
	const part = `${file}.${randomBytes(4).toString('hex')}.part`
	writeFileSync(part, data)
	renameSync(part, file)
	writeFileSync(`${file}.type`, 'application/pdf')
	return id
}
