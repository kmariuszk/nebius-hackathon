// Schema drift (T01 risks): the browser builds its schema from its shape and binding utils, the
// server from client/shared; a room on the server's schema must accept a browser that connects
// with the browser's. Vite loads the utils (TSX and CSS) as the dev server would.
// node --test --test-force-exit client/shapes/schemaDrift.test.ts
import * as syncCore from '@tldraw/sync-core'
import { InMemorySyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import type { TLParentId, TLRecord } from '@tldraw/tlschema'
import type { IndexKey } from '@tldraw/utils'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createTLSchemaFromUtils, defaultBindingUtils, defaultShapeUtils, type TLAnyShapeUtilConstructor } from 'tldraw'
import { createServer, type ViteDevServer } from 'vite'
import { paperShapeId } from '../../shared/ids.ts'
import { defaultPaperCardProps } from '../../shared/shapes.ts'
import { schema as serverSchema } from '../../server/rooms.ts'

// exported at runtime but left out of the published typings
const { getTlsyncProtocolVersion } = syncCore as unknown as { getTlsyncProtocolVersion: () => number }

let vite: ViteDevServer
let clientSchema: ReturnType<typeof createTLSchemaFromUtils>

before(async () => {
	vite = await createServer({
		root: fileURLToPath(new URL('../..', import.meta.url)),
		configFile: false,
		logLevel: 'silent',
		appType: 'custom',
		server: { middlewareMode: true, hmr: false, ws: false },
	})
	const shapes = await vite.ssrLoadModule('/client/shapes/index.ts')
	clientSchema = createTLSchemaFromUtils({
		shapeUtils: [...defaultShapeUtils, ...(shapes.customShapeUtils as TLAnyShapeUtilConstructor[])],
		bindingUtils: [...defaultBindingUtils, ...shapes.customBindingUtils],
	})
})

after(() => vite?.close())

test('the browser’s utils make the same schema as the server', () => {
	assert.deepEqual(clientSchema.serialize(), serverSchema.serialize())
	assert.ok('com.tldraw.shape.paper-card' in clientSchema.serialize().sequences)
	assert.ok('com.tldraw.binding.note-pin' in clientSchema.serialize().sequences)
})

test('a browser on its own schema loads the server’s paper cards and its own writes are committed', async () => {
	const card = (paperId: string, schema: typeof serverSchema) =>
		schema.types.shape.create({
			id: paperShapeId(paperId),
			type: 'paper-card',
			parentId: 'page:page' as TLParentId,
			index: 'a1' as IndexKey,
			props: defaultPaperCardProps(paperId, { title: 'A paper', kind: 'suggestion' }),
		})
	const room = new TLSocketRoom<TLRecord, void>({ schema: serverSchema, storage: new InMemorySyncStorage<TLRecord>() })
	room.storage.transaction((txn) => void txn.set(paperShapeId('pmid:1'), serverSchema.types.shape.validate(card('pmid:1', serverSchema))))

	// what the room sends, unwrapped from its batches
	const sent: { type: string; [key: string]: unknown }[] = []
	let closed: string | null = null
	const socket = {
		readyState: 1,
		send(message: string) {
			const m = JSON.parse(message)
			sent.push(...(m.type === 'data' ? m.data : [m]))
		},
		close: (_code?: number, reason?: string) => void (closed = reason ?? 'closed'),
		addEventListener() {},
		removeEventListener() {},
	}
	const say = (message: object) => room.handleSocketMessage('s1', JSON.stringify(message))
	const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

	room.handleSocketConnect({ sessionId: 's1', socket })
	say({
		type: 'connect',
		connectRequestId: 'c1',
		lastServerClock: 0,
		protocolVersion: getTlsyncProtocolVersion(),
		schema: clientSchema.serialize(),
	})
	await settle()
	const connect = sent.find((m) => m.type === 'connect') as { diff: Record<string, [string, TLRecord]> } | undefined
	assert.ok(connect, `no connect reply: ${JSON.stringify(sent).slice(0, 200)}`)
	const loaded = Object.values(connect.diff).map(([, record]) => record)
	assert.ok(loaded.some((r) => r.id === paperShapeId('pmid:1')))
	for (const record of loaded) clientSchema.types[record.typeName].validate(record)

	say({ type: 'push', clientClock: 1, diff: { [paperShapeId('pmid:2')]: ['put', card('pmid:2', clientSchema)] } })
	await settle()
	assert.equal(closed, null)
	assert.deepEqual(
		sent.filter((m) => m.type === 'push_result').map((m) => m.action),
		['commit']
	)
	room.close()
})
