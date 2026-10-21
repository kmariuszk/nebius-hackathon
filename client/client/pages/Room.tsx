import { useSync } from '@tldraw/sync'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { defaultBindingUtils, defaultShapeUtils, Editor, Tldraw, type TLComponents } from 'tldraw'
import { boardApi } from '../api'
import { chatBus } from '../chat/chatBus'
import { ChatPanel } from '../chat/ChatPanel'
import { getBookmarkPreview } from '../getBookmarkPreview'
import { getDisplayName, getMemberId } from '../identity'
import { multiplayerAssetStore } from '../multiplayerAssetStore'
import { PinboardDefs, Strings } from '../pinboard/Strings'
import { RankedList } from '../pinboard/RankedList'
import { PinboardToolbar } from '../pinboard/Toolbar'
import { TopBar, type Wall } from '../pinboard/TopBar'
import '../pinboard/pinboard.css'
import { customBindingUtils, customShapeUtils, getShapeVisibility } from '../shapes'
import { registerBoardSideEffects } from '../sideEffects'
import { PaperWidgets } from '../widgets/PaperWidgets'

const shapeUtils = [...defaultShapeUtils, ...customShapeUtils]
const bindingUtils = [...defaultBindingUtils, ...customBindingUtils]

// The v6 board (docs/mockups/flashcard-v6.html): strings under the cards, and our own top bar and
// toolbar in place of tldraw's menus and panels.
const components: TLComponents = {
	OnTheCanvas: Strings,
	SvgDefs: PinboardDefs,
	MenuPanel: null,
	StylePanel: null,
	NavigationPanel: null,
	Toolbar: null,
	HelpMenu: null,
	SharePanel: null,
	DebugPanel: null,
	DebugMenu: null,
}

/** The first prompt on a board made from the Start page; H01's live check sends the same text. */
export function onboardingPrompt(question: string) {
	return question.trim()
		? `Start this board. The research question is: "${question.trim()}". The seed papers are already on the board. Find related papers, put the best ones on the board near the seeds, and tell me what you found.`
		: 'Start this board. The seed papers are already on the board. Work out the research question from them, then find related papers, put the best ones on the board near the seeds, and tell me what you found.'
}

// after this long on the board, what happened before counts as seen
const SEEN_AFTER_MS = 10_000

const WALL_KEY = 'pinboard-wall'
function loadWall(): Wall {
	try {
		return localStorage.getItem(WALL_KEY) === 'cork' ? 'cork' : 'paper'
	} catch {
		return 'paper'
	}
}

export function Room() {
	const { roomId = '' } = useParams<{ roomId: string }>()
	const [memberId] = useState(getMemberId)
	const [editor, setEditor] = useState<Editor | null>(null)
	const [chatOpen, setChatOpen] = useState(false)
	const [wall, setWall] = useState<Wall>(loadWall)

	// join the board in the board service (T08), so it knows who votes and who's here
	useEffect(() => {
		boardApi(roomId, memberId)
			.join(getDisplayName() ?? undefined)
			.catch((e) => console.warn(`Couldn't join board ${roomId}:`, e))
	}, [roomId, memberId])

	// a board made on the Start page opens with ?start=1: the chat opens and the agent starts on it
	useEffect(() => {
		const url = new URL(window.location.href)
		if (!url.searchParams.has('start')) return
		// gone from the URL first, so a reload (or React running this twice) doesn't start it again
		url.searchParams.delete('start')
		window.history.replaceState(window.history.state, '', url)
		boardApi(roomId, memberId)
			.get()
			.catch((e) => console.warn(`Couldn't read board ${roomId}; starting without its question:`, e))
			.then((board) => chatBus.ask({ text: onboardingPrompt(board ? board.question || board.title : '') }))
	}, [roomId, memberId])

	// Home's "Catch me up" count starts over once the researcher has been here a while
	useEffect(() => {
		const api = boardApi(roomId, memberId)
		const timer = setTimeout(() => {
			api
				.get()
				.then((board) => api.seen(board.lastSeq))
				.catch((e) => console.warn(`Couldn't mark board ${roomId} as seen:`, e))
		}, SEEN_AFTER_MS)
		return () => clearTimeout(timer)
	}, [roomId, memberId])

	// Create a store connected to multiplayer.
	const store = useSync({
		// We need to know the websockets URI...
		uri: `${window.location.origin}/api/connect/${roomId}`,
		// ...and how to handle static assets like images & videos
		assets: multiplayerAssetStore,
		// the server's schema has the same custom shapes and bindings (client/shared)
		shapeUtils,
		bindingUtils,
	})

	const changeWall = (next: Wall) => {
		setWall(next)
		try {
			localStorage.setItem(WALL_KEY, next)
		} catch {
			// the wall is a per-viewer convenience; without storage it resets on reload
		}
	}

	return (
		<div className="RoomWrapper">
			<TopBar
				roomId={roomId}
				editor={editor}
				wall={wall}
				onWall={changeWall}
				chatOpen={chatOpen}
				onChat={() => setChatOpen(!chatOpen)}
			/>
			<div className="RoomWrapper-content">
				<div className="Board" data-wall={wall}>
					{/* a column beside the canvas when open, so the open paper's widgets make room for it */}
					{editor && <RankedList editor={editor} />}
					<div className="Board-canvas">
						<Tldraw
							// we can pass the connected store into the Tldraw component which will handle
							// loading states & enable multiplayer UX like cursors & a presence menu
							store={store}
							shapeUtils={customShapeUtils}
							bindingUtils={customBindingUtils}
							getShapeVisibility={getShapeVisibility}
							components={components}
							options={{ deepLinks: true }}
							onMount={(editor) => {
								// when the editor is ready, we need to register our bookmark unfurling service
								editor.registerExternalAssetHandler('url', getBookmarkPreview)
								const unregister = registerBoardSideEffects(editor, memberId)
								setEditor(editor)
								return () => {
									unregister()
									setEditor(null)
								}
							}}
						/>
						{/* outside <Tldraw>, so pointer and keyboard events in the widgets never reach the canvas */}
						{editor && <PaperWidgets editor={editor} boardId={roomId} memberId={memberId} />}
						{editor && <PinboardToolbar editor={editor} />}
					</div>
					<ChatPanel boardId={roomId} memberId={memberId} editor={editor} open={chatOpen} onOpenChange={setChatOpen} />
				</div>
			</div>
		</div>
	)
}
