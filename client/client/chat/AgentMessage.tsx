import type { ComponentProps } from 'react'
import Markdown, { type Components, type ExtraProps } from 'react-markdown'
import { viewerBus } from './viewerBus'

// The agent's answer as Markdown. Only `paper:` and `https:` links survive; `paper:<id>` links
// (I4: the agent writes `[Title](paper:pmid:1)`) become buttons that focus this viewer's canvas.
// Raw HTML is shown as text (react-markdown's default without rehype-raw), images are dropped.

const keepSafeUrls = (url: string, key: string) => (key === 'href' && /^(paper|https):/i.test(url) ? url : null)

function Link({ href, children }: ComponentProps<'a'> & ExtraProps) {
	if (href && /^paper:/i.test(href)) {
		const paperId = decode(href.slice('paper:'.length))
		return (
			<button type="button" className="pmn" title="Show on the board" onClick={() => viewerBus.emit('focus', { paperIds: [paperId] })}>
				{children}
			</button>
		)
	}
	if (href) {
		return (
			<a href={href} target="_blank" rel="noopener noreferrer">
				{children}
			</a>
		)
	}
	return <span>{children}</span>
}

const components: Components = { a: Link }

export function AgentMessage({ text }: { text: string }) {
	return (
		<div className="ChatMsg-agent">
			<Markdown urlTransform={keepSafeUrls} components={components} disallowedElements={['img']}>
				{text}
			</Markdown>
		</div>
	)
}

function decode(s: string) {
	try {
		return decodeURIComponent(s)
	} catch {
		return s
	}
}
