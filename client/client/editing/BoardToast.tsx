import { useEffect } from 'react'
import { useValue } from 'tldraw'
import { boardToast } from './toast'

// The board's toast, bottom centre over the canvas, in the widgets' toast style; one at a time,
// gone after five seconds (six and a half with a button, as on the v6 board).
export function BoardToast() {
	const t = useValue(boardToast)
	useEffect(() => {
		if (!t) return
		const timer = setTimeout(() => boardToast.get()?.id === t.id && boardToast.set(null), t.action ? 6500 : 5000)
		return () => clearTimeout(timer)
	}, [t])
	if (!t) return null
	return (
		<div className="pb-toast" role="status">
			<span>{t.text}</span>
			{t.action && (
				<button
					type="button"
					onClick={() => {
						boardToast.set(null)
						t.action!.run()
					}}
				>
					{t.action.label}
				</button>
			)}
		</div>
	)
}
