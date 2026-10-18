import type { TLAnyBindingUtilConstructor, TLAnyShapeUtilConstructor, TLShape } from 'tldraw'

// Custom shape and binding utils for the browser (T01). Placeholders until the board model lands.
export const customShapeUtils: TLAnyShapeUtilConstructor[] = []
export const customBindingUtils: TLAnyBindingUtilConstructor[] = []

/** Passed to `<Tldraw getShapeVisibility>`: hides discarded papers and hidden links (T01). */
export function getShapeVisibility(_shape: TLShape): 'visible' | 'hidden' | 'inherit' {
	return 'inherit'
}
