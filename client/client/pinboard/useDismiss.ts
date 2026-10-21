import { useEffect, useRef, type RefObject } from 'react'

/** While `open`, a press outside `ref` (or Escape, unless `escape` is false) calls `onDismiss`. */
export function useDismiss(
	ref: RefObject<HTMLElement | null>,
	open: boolean,
	onDismiss: () => void,
	{ capture = false, escape = true }: { capture?: boolean; escape?: boolean } = {}
) {
	const latest = useRef(onDismiss)
	latest.current = onDismiss
	useEffect(() => {
		if (!open) return
		const outside = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) latest.current()
		}
		const key = (e: KeyboardEvent) => e.key === 'Escape' && latest.current()
		document.addEventListener('pointerdown', outside, capture)
		if (escape) document.addEventListener('keydown', key)
		return () => {
			document.removeEventListener('pointerdown', outside, capture)
			document.removeEventListener('keydown', key)
		}
	}, [ref, open, capture, escape])
}
