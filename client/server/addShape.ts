// Adds a shape to a room through the sync server, the same way a backend service would.
// Usage: node server/addShape.ts <roomId> [text] [serverUrl]                  (a sticky note)
//        node server/addShape.ts <roomId> --paper <paperId> [title] [serverUrl] (a paper card)
import { paperShapeId } from '../shared/ids.ts'
import { defaultPaperCardProps } from '../shared/shapes.ts'

const USAGE = 'Usage: node server/addShape.ts <roomId> [text] [serverUrl]\n' +
	'       node server/addShape.ts <roomId> --paper <paperId> [title] [serverUrl]'
const [roomId, ...args] = process.argv.slice(2)
if (!roomId) throw new Error(USAGE)
const isPaper = args[0] === '--paper'
if (isPaper && !args[1]) throw new Error(USAGE)
const DEFAULT_SERVER = 'http://localhost:5858'

function note(text = 'Hello from the server') {
	return {
		type: 'note',
		x: 100 + Math.random() * 400,
		y: 100 + Math.random() * 300,
		props: {
			color: 'yellow',
			labelColor: 'black',
			size: 'm',
			font: 'draw',
			fontSizeAdjustment: null,
			align: 'middle',
			verticalAlign: 'middle',
			growY: 0,
			url: '',
			richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
			scale: 1,
			textLastEditedBy: null,
		},
	}
}

// One card per paper: the ID comes from the paper ID, so a second run is refused (409), not doubled.
// Scored for two goals, so switching "Looking for" recolours it.
function paper(paperId: string, title = paperId) {
	return {
		id: paperShapeId(paperId),
		type: 'paper-card',
		x: 100 + Math.random() * 400,
		y: 100 + Math.random() * 300,
		meta: { createdBy: 'agent', onBehalfOf: 'cli', runId: null, paperId },
		props: defaultPaperCardProps(paperId, {
			title,
			scores: {
				'new-findings': { score: 0.8, fit: 'high', why: 'Added from the command line' },
				methods: { score: 0.3, fit: 'low', why: 'Added from the command line' },
			},
		}),
	}
}

const [shape, server] = isPaper
	? [paper(args[1], args[2]), args[3] ?? DEFAULT_SERVER]
	: [note(args[0]), args[1] ?? DEFAULT_SERVER]

const res = await fetch(`${server}/api/rooms/${roomId}/shapes`, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify([shape]),
})
console.log(res.status, await res.text())
