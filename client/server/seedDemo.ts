import { defaultPaperCardProps, NODE_SIZE } from '../shared/shapes.ts'
import { linkShapeId, paperShapeId } from '../shared/ids.ts'
import { normaliseType } from '../shared/display.ts'
import type { PaperCardProps } from '../shared/paperCard.ts'

// Fills a board with the v5 mockup's real papers (docs/mockups/flashcard-v5.html): 5 seeds, 4
// suggestions, 1 kept paper, their citation links and a pinned note. Re-running updates them.
// Usage: node server/seedDemo.ts <board> [--url http://localhost:5858]

const args = process.argv.slice(2)
const board = args.find((a) => !a.startsWith('--'))
const urlAt = args.indexOf('--url')
const base = urlAt >= 0 ? args[urlAt + 1] : 'http://localhost:5858'
if (!board) {
	console.error('Usage: node server/seedDemo.ts <board> [--url http://localhost:5858]')
	process.exit(1)
}
const meta = (paperId?: string) => ({ createdBy: 'agent', onBehalfOf: 'm_demo000000', runId: null, ...(paperId ? { paperId } : {}) })

const P = {
	"s1": {
		"x": 590,
		"y": 175,
		"kind": "seed",
		"pmid": "27124452",
		"title": "Dissecting the multicellular ecosystem of metastatic melanoma by single-cell RNA-seq",
		"authors": [
			"Itay Tirosh",
			"Benjamin Izar",
			"Sanjay M Prakadan",
			"et al."
		],
		"venue": "Science",
		"year": 2016,
		"url": "https://doi.org/10.1126/science.aad0501",
		"type": null,
		"citedBy": 4551,
		"figure": {
			"imageUrl": "https://cdn.ncbi.nlm.nih.gov/pmc/blobs/c11f/4944528/1f7a6569b280/nihms791837f1.jpg",
			"label": "Figure 1",
			"caption": "Dissection of melanoma with single-cell RNA-seq (A) Overview of workflow. (B) Chromosomal landscape of inferred large-scale copy number variations (CNVs) distinguishes malignant from non-malignant cells. The Mel80 tumor is shown with individual cells…",
			"captionByAi": false
		}
	},
	"s2": {
		"x": 1150,
		"y": 178,
		"kind": "seed",
		"pmid": "30388456",
		"title": "Defining T Cell States Associated with Response to Checkpoint Immunotherapy in Melanoma",
		"authors": [
			"Moshe Sade-Feldman",
			"Keren Yizhak",
			"Stacey L Bjorgaard",
			"et al."
		],
		"venue": "Cell",
		"year": 2018,
		"url": "https://doi.org/10.1016/j.cell.2018.10.038",
		"type": null,
		"citedBy": 1930,
		"figure": {
			"imageUrl": "https://cdn.ncbi.nlm.nih.gov/pmc/blobs/9bf0/6641984/f7c1a95952f5/nihms-1510803-f0003.jpg",
			"label": "Figure 2",
			"caption": "Identification of CD8 + T cell states associated with clinical outcome. A. tSNE plot of all CD8 + T cells collected in this study, with cells colored based on 2 clusters found by k -means clustering.",
			"captionByAi": false
		}
	},
	"s3": {
		"x": 890,
		"y": 525,
		"kind": "seed",
		"pmid": "34290406",
		"title": "Phenotype, specificity and avidity of antitumour CD8+ T cells in melanoma",
		"authors": [
			"Giacomo Oliveira",
			"Kari Stromhaug",
			"Susan Klaeger",
			"et al."
		],
		"venue": "Nature",
		"year": 2021,
		"url": "https://doi.org/10.1038/s41586-021-03704-y",
		"type": null,
		"citedBy": 490,
		"figure": {
			"imageUrl": "https://cdn.ncbi.nlm.nih.gov/pmc/blobs/5722/9187974/b8cc79712593/nihms-1810830-f0001.jpg",
			"label": "Fig. 1",
			"caption": "Distinct cell states among CD8 + TCR clonotype families in melanoma. a , Schema of sample collection, processing and single-cell sequencing analysis of melanoma and peripheral blood samples. b , UMAP of scRNA-seq data from CD8 + melanoma TILs.",
			"captionByAi": false
		}
	},
	"s4": {
		"x": 1095,
		"y": 650,
		"kind": "seed",
		"pmid": "35508657",
		"title": "Landscape of helper and regulatory antitumour CD4+ T cells in melanoma",
		"authors": [
			"Giacomo Oliveira",
			"Kari Stromhaug",
			"Nicoletta Cieri",
			"et al."
		],
		"venue": "Nature",
		"year": 2022,
		"url": "https://doi.org/10.1038/s41586-022-04682-5",
		"type": null,
		"citedBy": 175,
		"figure": {
			"imageUrl": "https://cdn.ncbi.nlm.nih.gov/pmc/blobs/4a8e/9815755/f1dba1bc4efd/nihms-1861468-f0001.jpg",
			"label": "Fig. 1",
			"caption": "Melanoma HLA class II expression and phenotype of CD4 + TIL TCR clonotypes. a , Schematic of processing and single-cell sequencing analysis of melanoma samples. b , Flow cytometric assessment of HLA class II expression in 4 pdMel-CLs under basal culture…",
			"captionByAi": false
		}
	},
	"s5": {
		"x": 715,
		"y": 262,
		"kind": "seed",
		"pmid": "34035069",
		"title": "Single-Cell Characterization of the Immune Microenvironment of Melanoma Brain and Leptomeningeal Metastases",
		"authors": [
			"Inna Smalley",
			"Zhihua Chen",
			"Manali Phadke",
			"et al."
		],
		"venue": "Clinical Cancer Research",
		"year": 2021,
		"url": "https://doi.org/10.1158/1078-0432.CCR-21-1694",
		"type": null,
		"citedBy": 127,
		"figure": {
			"imageUrl": "https://cdn.ncbi.nlm.nih.gov/pmc/blobs/d6ef/8282775/38fa574fd456/nihms-1709372-f0002.jpg",
			"label": "Figure 2",
			"caption": "The T and NK cell landscape of melanoma metastases. A: t-SNE plot showing the distribution of T and NK cells from melanoma metastatic to the skin, brain and leptomeninges. B: Expression of key T cell activation markers and immune checkpoints across all…",
			"captionByAi": false
		}
	},
	"k1": {
		"x": 925,
		"y": 672,
		"kind": "kept",
		"pmid": "39609626",
		"title": "Circulating tumor-reactive KIR+CD8+ T cells suppress anti-tumor immunity in patients with melanoma",
		"authors": [
			"Benjamin Y Lu",
			"Liliana E Lucca",
			"Wesley Lewis",
			"et al."
		],
		"venue": "Nature Immunology",
		"year": 2025,
		"url": "https://doi.org/10.1038/s41590-024-02023-4",
		"type": null,
		"citedBy": 12,
		"figure": null
	},
	"n1": {
		"x": 1060,
		"y": 500,
		"kind": "new",
		"pmid": "41261135",
		"title": "Tumour-reactive heterotypic CD8 T cell clusters from clinical samples",
		"authors": [
			"Sofía Ibáñez-Molero",
			"Johanna Veldman",
			"Juan Simon Nieto",
			"et al."
		],
		"venue": "Nature",
		"year": 2026,
		"url": "https://doi.org/10.1038/s41586-025-09754-w",
		"type": null,
		"citedBy": 24,
		"figure": {
			"imageUrl": "https://cdn.ncbi.nlm.nih.gov/pmc/blobs/e043/12779571/5ed0b509cf35/41586_2025_9754_Fig3_HTML.jpg",
			"label": "Fig. 3",
			"caption": "Shows the single-cell RNA and TCR workflow, and the CD8+ T-cell states it finds.",
			"captionByAi": true
		},
		"why": {
			"evidence": [
				"Isolates ",
				{
					"t": "CD8+ T cells clustered with tumour cells",
					"ev": "q1"
				},
				" from melanoma metastases and finds them ",
				{
					"t": "tumour-reactive",
					"ev": "q2"
				},
				", building on ",
				{
					"t": "three of your seeds",
					"ev": "c1"
				},
				"."
			],
			"method": [
				"Adds a way to ",
				{
					"t": "isolate T-cell clusters with imaging flow cytometry",
					"ev": "q1"
				},
				", then profiles them with ",
				{
					"t": "single-cell RNA-seq",
					"ev": "q2"
				},
				"."
			]
		},
		"score": {
			"evidence": 0.88,
			"method": 0.66
		},
		"quotes": {
			"q1": {
				"ok": true,
				"t": "Here, using conventional and imaging flow cytometry, we show that from 21 out of 21 human melanoma metastases, we could isolate heterotypic clusters, comprising CD8+ T cells interacting with one or more tumour cells and/or antigen-presenting cells (APCs)."
			},
			"q2": {
				"ok": true,
				"t": "Single-cell RNA-sequencing analysis revealed that T cells from clusters were enriched for gene signatures associated with tumour reactivity and exhaustion."
			},
			"q3": {
				"ok": true,
				"t": "T cells that were expanded from clusters ex vivo exerted on average ninefold increased killing activity towards autologous melanomas, which was accompanied by enhanced cytokine production."
			}
		},
		"gaps": [
			"Whether it supports or challenges your seeds’ findings",
			"Methods and supplement: only the abstract and one figure read so far"
		],
		"foundBy": [
			"co-citation",
			"cites 3 of your seeds (PubMed)"
		],
		"glance": [
			[
				"Samples",
				"21 melanoma metastases",
				"q1",
				"same"
			],
			[
				"Method",
				"Flow cytometry pulls out CD8+ T cells clustered with tumour cells",
				"q1",
				"adds"
			],
			[
				"Readout",
				"Single-cell RNA sequencing of the clustered T cells",
				"q2",
				"same"
			],
			[
				"Finding",
				"Clustered T cells are tumour-reactive and kill melanoma about 9× better",
				"q3",
				null
			]
		],
		"working": false,
		"summary": "Do tumour-reactive CD8+ T cells sit in clusters with tumour cells? Flow cytometry to isolate clusters from 21 melanoma metastases, then single-cell RNA and TCR sequencing. Clustered T cells were more tumour-reactive and, once expanded, killed melanoma cells about nine times better."
	},
	"n2": {
		"x": 1300,
		"y": 560,
		"kind": "new",
		"pmid": "36223726",
		"title": "Spatial maps of T cell receptors and transcriptomes reveal distinct immune niches and interactions in the adaptive immune response",
		"authors": [
			"Sophia Liu",
			"J Bryan Iorgulescu",
			"Shuqiang Li",
			"et al."
		],
		"venue": "Immunity",
		"year": 2022,
		"url": "https://doi.org/10.1016/j.immuni.2022.09.002",
		"type": null,
		"citedBy": 122,
		"figure": {
			"imageUrl": "https://cdn.ncbi.nlm.nih.gov/pmc/blobs/2249/9745674/0978c6bf52ee/nihms-1841817-f0005.jpg",
			"label": "Figure 5",
			"caption": "Shows one T-cell clone and the tumour cells around it in a melanoma sample.",
			"captionByAi": true
		},
		"why": {
			"evidence": [
				"Mostly a method paper: ",
				{
					"t": "melanoma is one of two tumour types",
					"ev": "q2"
				},
				" it was tested on, so it adds little melanoma evidence."
			],
			"method": [
				"A new method that ",
				{
					"t": "reads T-cell receptors and whole transcriptomes in intact tissue",
					"ev": "q1"
				},
				", and ",
				{
					"t": "it works on archived clinical samples",
					"ev": "q3",
					"unv": true
				},
				"."
			]
		},
		"score": {
			"evidence": 0.4,
			"method": 0.9
		},
		"quotes": {
			"q1": {
				"ok": true,
				"t": "Here, we developed Slide-TCR-seq, a 10-μm-resolution method, to sequence whole transcriptomes and TCRs within intact tissues."
			},
			"q2": {
				"ok": true,
				"t": "Profiling T cells in renal cell carcinoma and melanoma specimens revealed heterogeneous immune responses: T cell states and infiltration differed intra- and inter-clonally, and adjacent tumor and immune cells exhibited distinct gene expression."
			},
			"q3": {
				"ok": false,
				"t": "It works on archived clinical samples.",
				"closest": "We confirmed the ability of Slide-TCR-seq to map the characteristic locations of T cells and their receptors in mouse spleen."
			}
		},
		"gaps": [
			"How many melanoma samples there were, and how deeply they were profiled",
			"Whether the method needs fresh-frozen tissue"
		],
		"foundBy": [
			"co-citation",
			"cites 3 of your seeds (PubMed)",
			"a Semantic Scholar recommendation"
		],
		"glance": [
			[
				"Method",
				"Slide-TCR-seq reads T-cell receptors and whole transcriptomes in intact tissue",
				"q1",
				"adds"
			],
			[
				"Tested on",
				"Kidney cancer and melanoma samples",
				"q2",
				"adds"
			],
			[
				"Finding",
				"T-cell states and infiltration differ within and between clones",
				"q2",
				null
			]
		],
		"working": false,
		"summary": "Where do individual T-cell clones sit in tissue? Slide-TCR-seq: 10 µm beads that read T-cell receptors and whole transcriptomes in place. In kidney cancer and melanoma, T-cell states and infiltration differed within and between clones."
	},
	"n3": {
		"x": 600,
		"y": 560,
		"kind": "new",
		"pmid": "39372744",
		"title": "IMMUNE AND MOLECULAR CORRELATES OF RESPONSE TO IMMUNOTHERAPY REVEALED BY BRAIN-METASTATIC MELANOMA MODELS",
		"authors": [
			"Amélie Daugherty-Lopès",
			"Eva Pérez-Guijarro",
			"Vishaka Gopalan",
			"et al."
		],
		"venue": "bioRxiv",
		"year": 2024,
		"url": "https://doi.org/10.1101/2024.08.26.609785",
		"type": "Preprint",
		"citedBy": 0,
		"figure": null,
		"why": {
			"evidence": [
				"Extends ",
				{
					"t": "your brain-metastasis seed",
					"ev": "c1"
				},
				" with ",
				{
					"t": "mouse models of melanoma brain metastases",
					"ev": "q1"
				},
				" that respond to immunotherapy the way patients do."
			],
			"method": [
				"Offers ",
				{
					"t": "two mouse models of melanoma brain metastases",
					"ev": "q1"
				},
				", useful if you need a model system rather than patient samples."
			]
		},
		"score": {
			"evidence": 0.58,
			"method": 0.48
		},
		"quotes": {
			"q1": {
				"ok": true,
				"t": "Here, we developed two mouse melanoma BrM models that recapitulate the disparate responses to ICB seen in patients."
			},
			"q2": {
				"ok": true,
				"t": "BR1-responsive tumor cells express inflammatory programs that polarize microglia into reactive states, eliciting robust T cell recruitment."
			},
			"q3": {
				"ok": true,
				"t": "In humans, BR1 and BR3 expression signatures correlate positively or negatively with T cell infiltration and BrM patient outcomes, respectively."
			}
		},
		"gaps": [
			"Preprint, not peer reviewed yet",
			"Mouse models: the link to patients rests on a signature correlation"
		],
		"foundBy": [
			"Tavily (recent preprints)",
			"cites 3 of your seeds"
		],
		"glance": [],
		"working": true,
		"summary": "Why do melanoma brain metastases respond so differently to immunotherapy? Two mouse models that mirror responders and non-responders. In responders, tumour cells push microglia into reactive states that recruit T cells."
	},
	"n4": {
		"x": 925,
		"y": 300,
		"kind": "new",
		"pmid": "39820025",
		"title": "Biological and clinical significance of tumour-infiltrating lymphocytes in the era of immunotherapy: a multidimensional approach",
		"authors": [
			"Miguel Lopez de Rodas",
			"Maria Villalba-Esparza",
			"Miguel F Sanmamed",
			"et al."
		],
		"venue": "Nature Reviews Clinical Oncology",
		"year": 2025,
		"url": "https://doi.org/10.1038/s41571-024-00984-x",
		"type": "Review",
		"citedBy": 86,
		"figure": null,
		"why": {
			"evidence": [
				"A review that ",
				{
					"t": "cites three of your seeds",
					"ev": "c1"
				},
				" and ",
				{
					"t": "sums up what TILs tell us about immunotherapy",
					"ev": "q2"
				},
				". Background, no new data."
			],
			"method": [
				"A review, but it ",
				{
					"t": "covers single-cell and spatial ways to study T cells",
					"ev": "q1"
				},
				". No method of its own."
			]
		},
		"score": {
			"evidence": 0.26,
			"method": 0.3
		},
		"quotes": {
			"q1": {
				"ok": true,
				"t": "Numerous studies have evaluated the prognostic and predictive value of TILs and the mechanisms that govern T cell dysfunction, fuelled by technical developments in single-cell transcriptomics, proteomics, high-dimensional spatial platforms and advanced computational models."
			},
			"q2": {
				"ok": true,
				"t": "In this Review, we discuss a conceptual framework for the systematic study of TILs and summarize the evidence regarding their biological properties and biomarker potential for ICI therapy."
			},
			"q3": {
				"ok": true,
				"t": "Immune-checkpoint inhibitors (ICIs) have improved clinical outcomes across several solid tumour types."
			}
		},
		"gaps": [
			"No free full text, so no figures were read",
			"A review, so it has no new data of its own"
		],
		"foundBy": [
			"co-citation",
			"cites 3 of your seeds (PubMed)"
		],
		"glance": [
			[
				"Covers",
				"Tumour-infiltrating lymphocytes across solid tumours",
				"q3",
				"other"
			],
			[
				"Methods reviewed",
				"Single-cell, proteomic and spatial studies",
				"q1",
				"adds"
			],
			[
				"Offers",
				"A framework for studying TILs as immunotherapy biomarkers",
				"q2",
				null
			]
		],
		"working": false,
		"summary": "What do tumour-infiltrating lymphocytes tell us about immunotherapy? A review of single-cell, proteomic and spatial studies. Proposes a framework for studying TILs and their value as biomarkers."
	}
}
const EDGES = [["n1","s1","cites"],["n1","s2","cites"],["n1","s3","cites"],["n2","s2","cites"],["n2","s3","cites"],["n2","s4","cites"],["n3","s2","cites"],["n3","s3","cites"],["n3","s5","cites"],["n4","s1","cites"],["n4","s2","cites"],["n4","s3","cites"],["k1","s1","cites"],["k1","s2","cites"],["k1","s3","cites"],["k1","s4","cites"],["s2","s1","cites"],["s3","s2","cites"],["s4","s1","cites"],["s4","s2","cites"],["s4","s3","cites"],["s5","s1","cites"],["n1","k1","similar"]]

type Raw = (typeof P)[keyof typeof P] & Record<string, any>
const pid = (k: string) => `pmid:${(P as Record<string, Raw>)[k].pmid}`
const fitOf = (s: number) => (s >= 0.7 ? 'high' : s >= 0.45 ? 'medium' : 'low') as 'high' | 'medium' | 'low'
const plain = (parts: (string | { t: string })[]) => parts.map((p) => (typeof p === 'string' ? p : p.t)).join('')
const pubmed = (pmid: string, text: string) => {
	const w = text.replace(/\.$/, '').split(/\s+/)
	const enc = (t: string) => encodeURIComponent(t).replace(/-/g, '%2D')
	return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/#:~:text=${enc(w.slice(0, 6).join(' '))},${enc(w.slice(-4).join(' '))}`
}
const degree = (k: string) => EDGES.filter(([a, b]) => a === k || b === k).length

const shapes: Record<string, unknown>[] = []
const bindings: Record<string, unknown>[] = []
const box: Record<string, { x: number; y: number; w: number }> = {}

for (const [k, raw] of Object.entries(P as Record<string, Raw>)) {
	const paperId = pid(k)
	const square = raw.kind !== 'new'
	const lim = square ? NODE_SIZE.square : NODE_SIZE.circle
	const r = 14 + 4 * degree(k)
	const w = Math.max(lim.min, Math.min(lim.max, Math.round(2 * (square ? r * 0.8 : r))))
	const props: Partial<PaperCardProps> = {
		w,
		h: w,
		title: raw.title,
		authors: raw.authors,
		year: raw.year,
		venue: raw.venue,
		url: raw.url,
		type: raw.type ? normaliseType(raw.type) : 'article',
		typeRaw: raw.type ? raw.type.toLowerCase() : 'article',
		peerReviewed: raw.type !== 'Preprint',
		citedBy: raw.citedBy,
		kind: raw.kind === 'new' ? 'suggestion' : (raw.kind as 'seed' | 'kept'),
		status: raw.kind === 'new' ? 'new' : 'kept',
		keepBy: raw.kind === 'kept' ? ['m_demoana000'] : [],
		figure: raw.figure,
	}
	if (raw.why) {
		const parts = raw.why.evidence as (string | { t: string; ev: string })[]
		Object.assign(props, {
			working: raw.working,
			scores: {
				'new-findings': { score: raw.score.evidence, fit: fitOf(raw.score.evidence), why: plain(raw.why.evidence) },
				methods: { score: raw.score.method, fit: fitOf(raw.score.method), why: plain(raw.why.method) },
			},
			oneLine: plain(parts),
			claims: parts.flatMap((p) => (typeof p === 'string' ? [] : [{ text: p.t, evidence: [p.ev === 'c1' ? 'seeds' : p.ev] }])),
			quotes: Object.entries(raw.quotes as Record<string, { ok: boolean; t: string }>).map(([id, q]) => ({
				id,
				text: q.t,
				source: 'abstract',
				verified: q.ok,
				url: q.ok ? pubmed(raw.pmid, q.t) : `https://pubmed.ncbi.nlm.nih.gov/${raw.pmid}/`,
			})),
			glance: (raw.glance as [string, string, string, string | null][]).map(([label, text, quoteId, relation]) => ({ label, text, quoteId, relation })),
			summary: raw.summary,
			gaps: raw.gaps,
			foundBy: raw.foundBy,
		})
	}
	// Liu 2022: the split vote from the mockup
	if (k === 'n2') Object.assign(props, { status: 'contested', keepBy: ['m_demoana000'], discardBy: ['m_demoigor00'] })
	const x = raw.x - w / 2
	const y = raw.y - w / 2
	box[k] = { x, y, w }
	shapes.push({ id: paperShapeId(paperId), type: 'paper-card', x, y, props: defaultPaperCardProps(paperId, props), meta: meta(paperId) })
}

const richText = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
for (const [a, b, kind] of EDGES as [string, string, 'cites' | 'similar'][]) {
	const id = linkShapeId(pid(a), pid(b), kind)
	const A = box[a]
	const B = box[b]
	shapes.push({
		id,
		type: 'arrow',
		x: A.x + A.w / 2,
		y: A.y + A.w / 2,
		props: {
			kind: 'arc', elbowMidPoint: 0.5, dash: kind === 'similar' ? 'dashed' : 'solid', size: 's', fill: 'none', color: 'grey',
			labelColor: 'black', bend: 0, start: { x: 0, y: 0 }, end: { x: B.x - A.x, y: B.y - A.y },
			arrowheadStart: 'none', arrowheadEnd: kind === 'cites' ? 'arrow' : 'none', richText: richText(''),
			labelPosition: 0.5, font: 'sans', scale: 1,
		},
		meta: { ...meta(), kind, label: '', by: kind === 'cites' ? 'pubmed' : 'agent', hiddenByHuman: false },
	})
	for (const [terminal, k] of [['start', a], ['end', b]] as const) {
		bindings.push({
			id: `binding:${id.slice('shape:'.length)}-${terminal}`, typeName: 'binding', type: 'arrow', fromId: id, toId: paperShapeId(pid(k)),
			props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' }, meta: {},
		})
	}
}

// Ana's note on Ibáñez-Molero 2026, pinned beside it
const n1 = box.n1
const note = { dx: n1.w + 24, dy: n1.w / 2 - 56 }
const noteId = 'shape:agent-note-demo00000001'
shapes.push({
	id: noteId, type: 'note', x: n1.x + note.dx, y: n1.y + note.dy,
	props: {
		color: 'black', labelColor: 'black', size: 's', font: 'sans', fontSizeAdjustment: 1, align: 'start', verticalAlign: 'start',
		growY: 0, url: '', richText: richText('Could we sort clusters like this from our biopsies?'), scale: 0.8, textLastEditedBy: null,
	},
	meta: meta(pid('n1')),
})
bindings.push({ id: 'binding:note-pin-demo00000001', typeName: 'binding', type: 'note-pin', fromId: noteId, toId: paperShapeId(pid('n1')), props: note, meta: {} })

// insert-only creates; a shape that exists is patched instead, a binding that exists is left as is
async function send(method: 'POST' | 'PATCH', items: unknown[]) {
	const res = await fetch(`${base}/api/rooms/${encodeURIComponent(board!)}/shapes`, {
		method,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(items),
	})
	return { status: res.status, text: await res.text() }
}
let created = 0
let updated = 0
for (const item of [...shapes, ...bindings] as { id: string; typeName?: string }[]) {
	let res = await send('POST', [item])
	if (res.status === 409 && item.typeName !== 'binding') {
		res = await send('PATCH', [item])
		if (res.status === 200) updated++
	} else if (res.status === 200) created++
	if (res.status !== 200 && res.status !== 409) {
		console.error(`${item.id}: ${res.status} ${res.text}`)
		process.exitCode = 1
	}
}
console.log(`${board}: ${created} created, ${updated} updated (${shapes.length} shapes, ${bindings.length} bindings)`)
