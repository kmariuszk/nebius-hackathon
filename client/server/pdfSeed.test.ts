// PDF seeds: the text of small PDFs written in the test, through pdfjs-dist: node --test server/pdfSeed.test.ts
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { textPdf } from './fixtures/textPdf.ts'
import { findDoi, pdfSeed, readPdf, savePdf, setUploadsDir } from './pdfSeed.ts'

const dir = mkdtempSync(join(tmpdir(), 'pdf-seed-'))
setUploadsDir(join(dir, 'uploads'))
after(() => rmSync(dir, { recursive: true, force: true }))

test('the first DOI in the text, without the punctuation around it', () => {
	assert.equal(findDoi('Science 352, 189 (2016). doi: 10.1126/science.aad0501.'), '10.1126/science.aad0501')
	assert.equal(findDoi('see https://doi.org/10.1038/s41586-021-03704-y, then 10.1/x'), '10.1038/s41586-021-03704-y')
	assert.equal(findDoi('(DOI 10.1016/S0140-6736(20)30183-5)'), '10.1016/S0140-6736(20)30183-5')
	assert.equal(findDoi('“10.1158/1078-0432.CCR-21-1694”;'), '10.1158/1078-0432.CCR-21-1694')
	assert.equal(findDoi('Version 10.2 of the tool, page 10'), null)
})

test('a PDF with a DOI on its first page gives the DOI', async () => {
	const pdf = textPdf([
		{ text: 'Science 352, 189-196 (2016)', size: 8 },
		{ text: 'Dissecting the multicellular ecosystem of metastatic melanoma', size: 16 },
		{ text: 'DOI: 10.1126/science.aad0501.', size: 8 },
	])
	const { pages } = await readPdf(pdf)
	assert.deepEqual(pages[0].map((l) => [l.text, l.size]), [
		['Science 352, 189-196 (2016)', 8],
		['Dissecting the multicellular ecosystem of metastatic melanoma', 16],
		['DOI: 10.1126/science.aad0501.', 8],
	])
	assert.deepEqual(await pdfSeed(pdf), { doi: '10.1126/science.aad0501', title: 'Dissecting the multicellular ecosystem of metastatic melanoma' })
})

test('without a DOI, the title: the largest text on page 1 with the line it wraps onto, or the metadata title', async () => {
	const lines = [
		{ text: 'Author manuscript', size: 9 },
		{ text: 'Defining T cell states associated with response', size: 18 },
		{ text: 'to checkpoint immunotherapy in melanoma', size: 18 },
		{ text: 'Moshe Sade-Feldman, Keren Yizhak', size: 11 },
	]
	assert.deepEqual(await pdfSeed(textPdf(lines)), {
		doi: null,
		title: 'Defining T cell states associated with response to checkpoint immunotherapy in melanoma',
	})
	const titled = textPdf(lines, 'Defining T cell states in melanoma (author manuscript)')
	assert.deepEqual(await pdfSeed(titled), { doi: null, title: 'Defining T cell states in melanoma (author manuscript)' })
	// a typesetter's placeholder title isn't one
	assert.equal((await pdfSeed(textPdf(lines, 'Microsoft Word - draft3.docx'))).title, lines[1].text + ' ' + lines[2].text)
	assert.deepEqual(await pdfSeed(textPdf([{ text: 'p. 1', size: 9 }])), { doi: null, title: null })
})

test('something that isn’t a PDF throws', async () => {
	await assert.rejects(readPdf(new TextEncoder().encode('not a pdf at all')))
})

test('the PDF is kept with the uploads, once per content, with its type beside it', () => {
	const pdf = textPdf([{ text: 'A paper', size: 12 }])
	const id = savePdf(pdf)
	assert.match(id, /^pdf-[0-9a-f]{24}$/)
	assert.deepEqual(new Uint8Array(readFileSync(join(dir, 'uploads', id))), pdf)
	assert.equal(readFileSync(join(dir, 'uploads', `${id}.type`), 'utf8'), 'application/pdf')
	assert.equal(savePdf(pdf), id)
	assert.ok(!existsSync(join(dir, 'uploads', `${id}.part`)))
})
