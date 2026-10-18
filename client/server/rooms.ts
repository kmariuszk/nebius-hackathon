import {
	NodeSqliteWrapper,
	SQLiteSyncStorage,
	TLSocketRoom,
	type TLSyncStorageTransaction,
	type TLSyncStorageTransactionCallback,
} from '@tldraw/sync-core'
import {
	createTLSchema,
	defaultBindingSchemas,
	defaultShapeSchemas,
	type TLBinding,
	type TLRecord,
	type TLShape,
} from '@tldraw/tlschema'
import { getIndexAbove, isEqual, type IndexKey } from '@tldraw/utils'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { customBindingSchemas } from '../shared/bindings.ts'
import { customShapeSchemas } from '../shared/shapes.ts'

// The board rooms: one TLSocketRoom per room, each saved to its own SQLite file under
// DATA_DIR/rooms. The sync socket, the REST shapes route and the canvas MCP all write here.

// the browser registers the same custom shapes and bindings (client/shared), so their records sync
export const schema = createTLSchema({
	shapes: { ...defaultShapeSchemas, ...customShapeSchemas },
	bindings: { ...defaultBindingSchemas, ...customBindingSchemas },
})

export type Txn = TLSyncStorageTransaction<TLRecord>

export class HttpError extends Error {
	status: number
	constructor(status: number, message: string) {
		super(message)
		this.status = status
	}
}

// room and upload ids come from URLs, so strip anything that could escape the data dir
export const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]+/g, '_')

let roomsDir = join(resolve(process.env.DATA_DIR ?? '.data'), 'rooms')

/** Tests point the rooms at a temp dir before opening any. */
export function setRoomsDir(dir: string) {
	roomsDir = dir
}

interface OpenRoom {
	room: TLSocketRoom<TLRecord, void>
	db: DatabaseSync
	idleTimer?: ReturnType<typeof setTimeout>
}

const rooms = new Map<string, OpenRoom>()

// A room whose database can't be opened (corrupt file, full disk, failed migration) would
// otherwise be retried on every browser reconnect; remember the failure for a while instead.
const failedRooms = new Map<string, number>()
const FAILED_ROOM_RETRY_MS = 30_000

/** A room opened only by agent or REST writes closes this long after the last one if nobody connects. */
export const IDLE_CLOSE_MS = 30_000

function closeRoom(id: string) {
	const open = rooms.get(id)
	if (!open) return
	clearTimeout(open.idleTimer)
	rooms.delete(id)
	open.room.close()
	open.db.close()
}

/** Opens the room (or returns it if open). Any use cancels a pending idle close. */
export function getRoom(roomId: string) {
	const id = safeId(roomId)
	const open = rooms.get(id)
	if (open) {
		clearTimeout(open.idleTimer)
		return open.room
	}

	const failedAt = failedRooms.get(id)
	if (failedAt !== undefined && Date.now() - failedAt < FAILED_ROOM_RETRY_MS) {
		throw new HttpError(503, `Room ${id} failed to open recently`)
	}
	let db: DatabaseSync | undefined
	let room: TLSocketRoom<TLRecord, void>
	try {
		mkdirSync(roomsDir, { recursive: true })
		db = new DatabaseSync(join(roomsDir, `${id}.db`))
		room = new TLSocketRoom<TLRecord, void>({
			schema,
			storage: new SQLiteSyncStorage<TLRecord>({ sql: new NodeSqliteWrapper(db) }),
			// every change is already in SQLite, so the room can close when the last client leaves
			onSessionRemoved(room, { numSessionsRemaining }) {
				if (numSessionsRemaining === 0 && rooms.get(id)?.room === room) closeRoom(id)
			},
		})
	} catch (e) {
		db?.close()
		failedRooms.set(id, Date.now())
		throw e
	}
	failedRooms.delete(id)
	rooms.set(id, { room, db })
	return room
}

// Nobody may ever connect to a room an agent wrote to, so it must close on its own.
function scheduleIdleClose(id: string) {
	const open = rooms.get(id)
	if (!open || open.room.getNumActiveSessions() > 0) return
	clearTimeout(open.idleTimer)
	open.idleTimer = setTimeout(() => {
		if (rooms.get(id) === open && open.room.getNumActiveSessions() === 0) closeRoom(id)
	}, IDLE_CLOSE_MS)
	open.idleTimer.unref?.()
}

/** Reads the room in one transaction. */
export function readRoom<T>(roomId: string, fn: (txn: Txn) => T): T {
	return writeRoom(roomId, fn)
}

/** Runs `fn` in one storage transaction: all of it is written, or none of it if it throws. */
export function writeRoom<T>(roomId: string, fn: (txn: Txn) => T): T {
	const room = getRoom(roomId)
	try {
		return room.storage.transaction(fn as TLSyncStorageTransactionCallback<TLRecord, T>).result
	} finally {
		scheduleIdleClose(safeId(roomId))
	}
}

/** For tests: whether the room is in memory. */
export function isRoomOpen(roomId: string) {
	return rooms.has(safeId(roomId))
}

/** For tests and shutdown. */
export function closeAllRooms() {
	for (const id of [...rooms.keys()]) closeRoom(id)
}

export type ShapePatch = Partial<TLShape> & { id: TLShape['id'] }

// Creates and patches inside one transaction (decision D20). A create is insert-only: an id that
// already exists is refused, so a create can never wipe a shape someone has moved or edited.
export function writer(txn: Txn) {
	const records = [...txn.values()]
	const pageId = records
		.filter((r) => r.typeName === 'page')
		.sort((a, b) => (a.index < b.index ? -1 : 1))[0]?.id
	let index = records.reduce<IndexKey | null>(
		(max, r) => (r.typeName === 'shape' && (!max || r.index > max) ? r.index : max),
		null
	)
	return {
		pageId,

		/** Needs `type` and full `props`; the page, stacking order (always on top) and, unless given, id are filled in. */
		createShape(partial: Partial<TLShape>): TLShape {
			if (partial.id && txn.get(partial.id)) {
				throw new HttpError(409, `${partial.id} already exists; send a PATCH to change it`)
			}
			index = getIndexAbove(index)
			const shape = schema.types.shape.validate(
				schema.types.shape.create({ parentId: pageId, ...partial, index } as TLShape)
			) as TLShape
			txn.set(shape.id, shape)
			return shape
		},

		/** Needs `type`, `fromId`, `toId` and full `props`; both ends must already exist. */
		createBinding(partial: Partial<TLBinding>): TLBinding {
			if (partial.id && txn.get(partial.id)) {
				throw new HttpError(409, `${partial.id} already exists`)
			}
			const binding = schema.types.binding.validate(schema.types.binding.create(partial as TLBinding)) as TLBinding
			for (const end of [binding.fromId, binding.toId]) {
				if (txn.get(end)?.typeName !== 'shape') throw new HttpError(400, `${binding.id}: no shape ${end}`)
			}
			txn.set(binding.id, binding)
			return binding
		},

		/** Only the fields a patch names change: `props` and `meta` merge key by key; position and stacking stay unless set. */
		patchShape(patch: ShapePatch): TLShape {
			const current = txn.get(patch.id)
			if (current?.typeName !== 'shape') throw new HttpError(404, `No shape ${patch.id}`)
			if (patch.type && patch.type !== current.type) {
				throw new HttpError(400, `${patch.id} is a ${current.type}, not a ${patch.type}`)
			}
			const shape = schema.types.shape.validate({
				...current,
				...patch,
				props: { ...current.props, ...patch.props },
				meta: { ...current.meta, ...patch.meta },
			} as TLShape) as TLShape
			// every set ticks the clock and syncs to every browser, so skip ones that change nothing
			if (!isEqual(shape, current)) txn.set(shape.id, shape)
			return shape
		},
	}
}

type Item = Record<string, unknown>

// Add new shapes, and bindings between shapes, to a room from the server; connected clients see
// them live. Items with `typeName: 'binding'` are bindings (full record); anything else is a shape.
// Throws without writing anything if any item fails.
export function putShapes(roomId: string, items: Item[]) {
	return writeRoom(roomId, (txn) => {
		const w = writer(txn)
		const ids: string[] = []
		for (const item of items) {
			if (!item || typeof item !== 'object') throw new HttpError(400, 'Each item must be an object')
			if (item.typeName !== undefined && item.typeName !== 'shape' && item.typeName !== 'binding') {
				throw new HttpError(400, `Can't create a ${item.typeName}; only shapes and bindings`)
			}
		}
		// shapes first, so a binding may point at a shape created later in the same request
		items.forEach((item, i) => {
			if (item.typeName !== 'binding') ids[i] = w.createShape(item as Partial<TLShape>).id
		})
		items.forEach((item, i) => {
			if (item.typeName === 'binding') ids[i] = w.createBinding(item as Partial<TLBinding>).id
		})
		return ids
	})
}

// Change existing shapes in place (see writer().patchShape). Throws without writing anything if any patch fails.
export function patchShapes(roomId: string, patches: ShapePatch[]) {
	return writeRoom(roomId, (txn) => {
		const w = writer(txn)
		return patches.map((patch) => {
			if (!patch || typeof patch !== 'object') throw new HttpError(400, 'Each patch must be an object')
			return w.patchShape(patch).id
		})
	})
}
