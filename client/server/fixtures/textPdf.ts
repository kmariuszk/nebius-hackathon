// A one-page PDF written by hand, for tests that read PDF text: each line in Helvetica at its own
// size, top down, and an optional metadata title. ASCII only.
export function textPdf(lines: { text: string; size: number }[], title?: string): Uint8Array<ArrayBuffer> {
	const escape = (s: string) => s.replace(/[\\()]/g, '\\$&')
	const content = lines.map((l, i) => `BT /F1 ${l.size} Tf 72 ${720 - i * 48} Td (${escape(l.text)}) Tj ET`).join('\n')
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
		...(title ? [`<< /Title (${escape(title)}) >>`] : []),
	]
	let pdf = '%PDF-1.4\n'
	const offsets = objects.map((o, i) => {
		const at = pdf.length
		pdf += `${i + 1} 0 obj\n${o}\nendobj\n`
		return at
	})
	const xref = pdf.length
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${title ? ` /Info ${objects.length} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`
	return new TextEncoder().encode(pdf)
}
