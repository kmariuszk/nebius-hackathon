import { createContext, useContext, type CSSProperties, type ReactNode } from 'react'
import type { Editor } from 'tldraw'
import type { PaperCardShape } from '../../shared/shapes.ts'
import type { Related } from './fade.ts'

// What every widget around the open paper shares, from OpenPaper in PaperWidgets.tsx.

export interface Toast {
	text: string
	undo?: () => void
}

export interface LinkedPaper {
	shapeId: string
	paperId: string
	kind: PaperCardShape['props']['kind']
	label: string
	fit: 'low' | 'medium' | 'high' | null
	/** How it's linked to the open paper: "cites it", "cited by it", "similar", or a person's label. */
	relation: string
	/** It cites the open paper, or the open paper cites it. */
	cites: 'in' | 'out' | null
}

export interface WidgetsApi {
	editor: Editor
	memberId: string
	shape: PaperCardShape
	goal: string
	more: boolean
	related: Related
	linked: LinkedPaper[]
	/** Reports a widget's natural height for the layout. */
	measure(key: string): (el: HTMLElement | null) => void
	/** Widgets the layout holds below their natural height. */
	limits: Record<string, number>
	/** The grow-out-of-the-node animation for a widget, once the layout is known. */
	pop(key: string): CSSProperties | undefined
	/** The widget holding what's being peeked at (it stays visible while the rest fade). */
	peekKey: string | null
	/** Lights papers up on the board and fades every widget but `key`; null ends it. */
	peek(key: string | null, paperIds?: string[]): void
	/** Shows a dark popover under `el`, peeking at `peek` while it's open. */
	showPop(el: HTMLElement, content: ReactNode, peek?: { key: string; paperIds: string[] }): void
	hidePop(): void
	toast(toast: Toast): void
	openFigure(): void
	close(): void
	noteDraft: boolean
	setNoteDraft(on: boolean): void
}

export const WidgetsContext = createContext<WidgetsApi | null>(null)

export function useWidgets(): WidgetsApi {
	const api = useContext(WidgetsContext)
	if (!api) throw new Error('useWidgets outside OpenPaper')
	return api
}
