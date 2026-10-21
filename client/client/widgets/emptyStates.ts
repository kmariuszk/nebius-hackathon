import type { PaperCardProps } from '../../shared/paperCard.ts'

// What Why it matters to you, The paper at a glance and the figure show while the agent is still
// reading, once it has stopped without filling them in, and on a seed, which is never read (F20).
// Every empty state ends: nothing spins once `working` is off.

export type EmptyWidget = 'why' | 'glance' | 'figure'

export type EmptyState =
	/** It has what it shows. */
	| { kind: 'filled' }
	/** Still being read: the widget's spinner line. */
	| { kind: 'working' }
	/** Nothing more is coming: one line in its place. */
	| { kind: 'ended'; text: string }
	/** A seed: one line, and Why hides its fit line. */
	| { kind: 'seed'; text: string }
	| { kind: 'hidden' }

export type EmptyCard = Pick<PaperCardProps, 'kind' | 'working' | 'gaps' | 'oneLine' | 'glance' | 'figure'>

// the background pass's gaps (H03, harness/agents/master/background.py)
const NO_WHY = "The agent couldn't write why"
const NO_GLANCE = "The agent couldn't draw the paper at a glance"

const gapStarting = (gaps: string[], start: string) => gaps.find((g) => g.replace(/’/g, "'").startsWith(start))

export function emptyState(card: EmptyCard, widget: EmptyWidget): EmptyState {
	const seed = card.kind === 'seed'
	if (widget === 'why') {
		if (seed) return { kind: 'seed', text: 'One of your seed papers.' }
		if (card.working) return { kind: 'working' }
		if (card.oneLine) return { kind: 'filled' }
		return { kind: 'ended', text: gapStarting(card.gaps, NO_WHY) ?? 'The agent hasn’t explained this paper yet.' }
	}
	if (widget === 'glance') {
		if (seed) return { kind: 'hidden' }
		if (card.glance.length) return { kind: 'filled' }
		if (card.working) return { kind: 'working' }
		const gap = gapStarting(card.gaps, NO_GLANCE)
		return gap ? { kind: 'ended', text: gap } : { kind: 'hidden' }
	}
	if (card.figure) return { kind: 'filled' }
	if (seed) return { kind: 'hidden' }
	if (card.working) return { kind: 'working' }
	return { kind: 'ended', text: 'No free figure for this paper.' }
}
