import { useMemo, useState } from 'react'
import type { ToolItem } from './chatState'
import { findBoardTargets, prettyJson, toolMetaLine } from './format'
import { viewerBus } from './viewerBus'

// One card per tool call (I2, including calls inside sub-agents): title, status, v4's
// "model · time · cost" line, and the raw input and output behind Details.

const PREVIEW_CHARS = 1200

export function ToolCard({ card }: { card: ToolItem }) {
	const [open, setOpen] = useState(false)
	const meta = toolMetaLine(card.meta)
	// read tools (get_board) name every paper on the board, which isn't worth a button
	const targets = useMemo(
		() => (card.status === 'completed' && card.toolKind !== 'read' ? findBoardTargets(card.rawOutput) : null),
		[card.status, card.toolKind, card.rawOutput]
	)
	const canShow = !!targets && (targets.paperIds.length > 0 || targets.shapeIds.length > 0)
	const hasDetails = card.rawInput !== undefined || card.rawOutput !== undefined
	return (
		<div className="ChatTool" data-status={card.status}>
			<div className="ChatTool-h">
				<StatusIcon status={card.status} />
				<span className="ChatTool-title">{card.title}</span>
			</div>
			{card.summary && <div className="ChatTool-d">{card.summary}</div>}
			{(meta || canShow || hasDetails) && (
				<div className="ChatTool-foot">
					<span className="ChatTool-lbl">{meta}</span>
					{canShow && (
						<button type="button" className="ChatLinkBtn" onClick={() => targets && viewerBus.emit('focus', targets)}>
							Show on board
						</button>
					)}
					{hasDetails && (
						<button type="button" className="ChatLinkBtn" aria-expanded={open} onClick={() => setOpen(!open)}>
							{open ? 'Hide details' : 'Details'}
						</button>
					)}
				</div>
			)}
			{open && (
				<>
					<JsonBlock label="Input" value={card.rawInput} />
					<JsonBlock label="Output" value={card.rawOutput} />
				</>
			)}
		</div>
	)
}

function StatusIcon({ status }: { status: ToolItem['status'] }) {
	if (status === 'completed') return <span className="okc" aria-label="completed">✓</span>
	if (status === 'failed') return <span className="badc" aria-label="failed">✕</span>
	return <span className="spin" aria-label={status.replace('_', ' ')} />
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
	const [all, setAll] = useState(false)
	const text = useMemo(() => prettyJson(value), [value])
	if (!text) return null
	const long = text.length > PREVIEW_CHARS
	return (
		<div className="ChatTool-json">
			<div className="ChatTool-jsonLabel">{label}</div>
			<pre>{all || !long ? text : text.slice(0, PREVIEW_CHARS) + '…'}</pre>
			{long && (
				<button type="button" className="ChatLinkBtn" onClick={() => setAll(!all)}>
					{all ? 'Show less' : `Show all (${Math.round(text.length / 1000)}k characters)`}
				</button>
			)}
		</div>
	)
}
