import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useValue, type Editor, type TLShape } from 'tldraw'
import { cardLabel } from '../../shared/display'
import type { PaperCardShape } from '../../shared/shapes'
import { boardApi } from '../api'
import { changes } from '../pinboard/changes'
import { linkedCards } from '../pinboard/Strings'
import { linkEditorAt } from './linkState'
import {
	DELETED_TOAST,
	hiddenMeta,
	hiddenToast,
	kindOf,
	labelledMeta,
	LINK_SUGGESTIONS,
	linkNote,
	linkOptions,
} from './linkRules'
import { toast, undoAction } from './toast'

// The link editor (T14, v6 demo board): a small popover where you clicked a string. Name the
// link ("Why are these linked?"), hide it, or delete it, by kind (linkRules.ts). Outside <Tldraw>,
// like the paper widgets, so typing in it never reaches tldraw's shortcuts.

interface Props {
	editor: Editor
	boardId: string
	memberId: string
}

const close = () => linkEditorAt.set(null)

// the board service hears about a deleted similar link once Undo is no longer on offer; until
// then (or if the page closes first) get_board reads it from the room's tombstone
const REMOVE_AFTER_MS = 7000

export function LinkEditor({ editor, boardId, memberId }: Props) {
	const at = useValue(linkEditorAt)
	const link = useValue(
		'edited link',
		() => {
			const arrow = at ? editor.getShape(at.arrowId) : undefined
			const pair = arrow ? linkedCards(editor, arrow) : null
			return arrow && pair ? { arrow, pair } : null
		},
		[editor, at]
	)
	// the link went (a teammate deleted it, or its paper left the board)
	useEffect(() => {
		if (at && !link) close()
	}, [at, link])
	if (!at || !link) return null
	return <Open key={`${at.arrowId} ${at.x} ${at.y}`} {...{ editor, boardId, memberId, at }} arrow={link.arrow} pair={link.pair} />
}

interface OpenProps extends Props {
	at: { x: number; y: number }
	arrow: TLShape
	pair: [PaperCardShape, PaperCardShape]
}

function Open({ editor, boardId, memberId, at, arrow, pair: [from, to] }: OpenProps) {
	const kind = kindOf(arrow.meta)
	const options = linkOptions(kind)
	// for Update suggestions (T13)
	const link = { from: from.props.paperId, to: to.props.paperId, kind }
	const was = typeof arrow.meta.label === 'string' ? arrow.meta.label : ''
	const [draft, setDraft] = useState(was)
	const ref = useRef<HTMLDivElement>(null)
	const input = useRef<HTMLInputElement>(null)
	const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

	useLayoutEffect(() => {
		const { w, h } = editor.getViewportScreenBounds()
		const height = ref.current?.offsetHeight ?? 0
		setPos({
			left: Math.max(12, Math.min(at.x - 150, w - 312)),
			top: Math.max(12, Math.min(at.y + 16, h - height - 12)),
		})
		input.current?.focus()
		input.current?.select()
	}, [editor, at])

	const commit = (value: string) => {
		const next = value.trim()
		close()
		if (next === was) return
		editor.markHistoryStoppingPoint('name a link')
		editor.updateShape({ id: arrow.id, type: arrow.type, meta: labelledMeta(arrow.meta, next, memberId) })
		changes.record(boardId, { type: 'link_renamed', ...link, label: next })
	}
	// a click anywhere else keeps what was typed, as on the v6 board
	const latest = useRef(() => commit(draft))
	latest.current = () => commit(draft)
	useEffect(() => {
		const outside = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) latest.current()
		}
		document.addEventListener('pointerdown', outside, true)
		return () => document.removeEventListener('pointerdown', outside, true)
	}, [])

	const hide = () => {
		const before = arrow.meta
		close()
		editor.markHistoryStoppingPoint('hide a link')
		editor.updateShape({ id: arrow.id, type: arrow.type, meta: hiddenMeta(arrow.meta) })
		const unrecord = changes.record(boardId, { type: 'link_hidden', ...link })
		toast({
			text: hiddenToast(kind),
			action: undoAction(() => {
				editor.updateShape({ id: arrow.id, type: arrow.type, meta: before })
				unrecord()
			}),
		})
	}

	const remove = () => {
		const shape = editor.getShape(arrow.id)
		const bindings = editor.getBindingsFromShape(arrow, 'arrow')
		if (!shape) return
		close()
		editor.markHistoryStoppingPoint('delete a link')
		editor.deleteShapes([arrow.id])
		const unrecord = changes.record(boardId, { type: 'link_removed', ...link })
		let undone = false
		if (options.recordRemoved) {
			setTimeout(() => {
				if (undone) return
				boardApi(boardId, memberId)
					.removeLink(from.props.paperId, to.props.paperId, kind)
					.catch((e) => console.warn(`Couldn't record the removed link on ${boardId}:`, e))
			}, REMOVE_AFTER_MS)
		}
		toast({
			text: DELETED_TOAST,
			action: undoAction(() => {
				undone = true
				editor.run(() => {
					editor.createShape(shape)
					editor.createBindings(bindings)
				})
				unrecord()
			}),
		})
	}

	return (
		<div
			ref={ref}
			className="pb-led"
			style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
			role="dialog"
			aria-label="Edit link"
			// keys typed here are the label's, not tldraw's shortcuts
			onKeyDown={(e) => e.stopPropagation()}
			onKeyUp={(e) => e.stopPropagation()}
		>
			<div className="le-h">
				{cardLabel(from)} <span>{kind === 'cites' ? '→' : '↔'}</span> {cardLabel(to)}
			</div>
			<input
				ref={input}
				maxLength={40}
				placeholder="Why are these linked?"
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault()
						commit(draft)
					} else if (e.key === 'Escape') {
						e.preventDefault()
						close()
					}
				}}
			/>
			<div className="chips">
				{LINK_SUGGESTIONS.map((s) => (
					<button type="button" key={s} className="fchip" onClick={() => commit(s)}>
						{s}
					</button>
				))}
			</div>
			<div className="le-note">{linkNote(kind, cardLabel(from), cardLabel(to), arrow.meta.by, memberId)}</div>
			<div className="le-f">
				{options.hide && (
					<button type="button" className="pb-btn text" onClick={hide}>
						Hide link
					</button>
				)}
				{options.delete && (
					<button type="button" className="pb-btn text" onClick={remove}>
						Delete link
					</button>
				)}
				<span className="pb-grow" />
				<button type="button" className="pb-btn primary" onClick={() => commit(draft)}>
					Done
				</button>
			</div>
		</div>
	)
}
