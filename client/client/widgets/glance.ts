import type { SeedRelation } from '../../shared/paperCard.ts'

// "The paper at a glance": the agent writes each step's label in words (Samples, Method,
// Tested on…); the widget picks an icon for it. The finding is drawn bold with a dark star.

export type GlanceIcon = 'samples' | 'method' | 'readout' | 'compare' | 'check' | 'scope' | 'finding'

const ICON_WORDS: [GlanceIcon, RegExp][] = [
	['finding', /find|result|offer|conclu|show/],
	['compare', /compar|versus|\bvs\b/],
	['check', /check|valid|confirm|patient/],
	['method', /method|technique|approach|assay|protocol|tool/],
	['readout', /readout|measure|sequenc|profil|analys|read/],
	['scope', /cover|scope|review|topic|field/],
	['samples', /sample|tested|model|cohort|tissue|data|subject|organism|cell/],
]

export function glanceIcon(label: string): GlanceIcon {
	const words = label.toLowerCase()
	return ICON_WORDS.find(([, re]) => re.test(words))?.[0] ?? 'method'
}

/** The mark on the right of a step, compared with the seeds. */
export const RELATION_LABEL: Record<SeedRelation, string> = {
	same: '✓ Same',
	adds: '＋ New',
	other: '≠ Differs',
}
