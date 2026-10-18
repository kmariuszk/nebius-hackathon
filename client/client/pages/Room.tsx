import { useSync } from '@tldraw/sync'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { defaultBindingUtils, defaultShapeUtils, Editor, Tldraw, type TLComponents } from 'tldraw'
import { boardApi } from '../api'
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
