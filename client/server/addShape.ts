// Adds a sticky note to a room through the sync server, the same way a backend service would.
// Usage: node server/addShape.ts <roomId> [text] [serverUrl]
const [roomId, text = 'Hello from the server', server = 'http://localhost:5858'] = process.argv.slice(2)
if (!roomId) throw new Error('Usage: node server/addShape.ts <roomId> [text] [serverUrl]')

const res = await fetch(`${server}/api/rooms/${roomId}/shapes`, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify([
		{
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
		},
	]),
})
console.log(res.status, await res.text())
export {} // makes top-level await type-check
