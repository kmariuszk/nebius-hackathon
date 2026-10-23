import { Box, type Editor } from 'tldraw'
import { CARD_SIZE } from '../../../shared/shapes.ts'

// A stand-in for tldraw's Editor in the editing wiring's tests, as filters.test.ts fakes what
// boardDerived needs: shapes and bindings in maps, the side-effect handlers the code registers,
// and writes that call them as tldraw's store does. Every write is the person's ('user'); the
// after-handlers, then the operation-complete handlers, run when the outermost operation ends.
// Deleting a shape first loosens the arrows bound to it and removes its bindings, as tldraw's own
// delete handler does, and only then asks the shape's delete handlers.

export interface FakeShape {
	id: string
	type: string
	x: number
	y: number
	rotation: number
	parentId: string
	props: Record<string, any>
	meta: Record<string, unknown>
}

export interface FakeBinding {
	id: string
	type: string
	fromId: string
	toId: string
	props: Record<string, any>
	meta: Record<string, unknown>
}

type Kind = 'shape' | 'binding'
type Rec = FakeShape | FakeBinding
type Handler = (...args: any[]) => any
type Ref = string | { id: string }

// registerBoardSideEffects reads the display name from localStorage (identity.ts), which Node lacks
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} } as unknown as Storage

const PAGE = 'page:1'
const idOf = (s: Ref) => (typeof s === 'string' ? s : s.id)

export function fakeEditor(initial: (Partial<FakeShape> & { id: string; type: string })[] = []) {
	const shapes = new Map<string, FakeShape>()
	const bindings = new Map<string, FakeBinding>()
	const handlers = new Map<string, Handler[]>()
	/** Every write that reached the store, in order: "create shape note", "update binding note-pin"… */
	const writes: string[] = []
	let pending = new Map<string, { kind: Kind; before?: Rec; after?: Rec }>()
	let depth = 0
	let made = 0
	let tool = 'select.idle'
	let selected: string[] = []

	const on = (name: string, fn: Handler) => {
		handlers.set(name, [...(handlers.get(name) ?? []), fn])
		return () => void handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== fn))
	}
	const call = (name: string, ...args: unknown[]) => (handlers.get(name) ?? []).map((h) => h(...args))

	// an operation completes even when it wrote nothing (a delete that was refused)
	const flush = () => {
		do {
			const events = pending
			pending = new Map()
			for (const { kind, before, after } of events.values()) {
				if (before && after) call(`afterChange ${kind}`, before, after, 'user')
				else if (before) call(`afterDelete ${kind}`, before, 'user')
				else if (after) call(`afterCreate ${kind}`, after, 'user')
			}
			if (!pending.size) call('operationComplete', 'user')
		} while (pending.size)
	}
	// writes inside an operation, or inside the handlers it runs, join it
	const run = <T>(fn: () => T): T => {
		depth++
		try {
			return fn()
		} finally {
			if (depth === 1) flush()
			depth--
		}
	}
	const touch = (kind: Kind, id: string, before: Rec | undefined, after: Rec | undefined) => {
		const seen = pending.get(id)
		if (seen) seen.after = after
		else pending.set(id, { kind, before, after })
	}
	const put = (kind: Kind, next: Rec) =>
		run(() => {
			const map = (kind === 'shape' ? shapes : bindings) as Map<string, Rec>
			const prev = map.get(next.id)
			let rec = next
			if (prev) for (const h of handlers.get(`beforeChange ${kind}`) ?? []) rec = h(prev, rec, 'user')
			else for (const h of handlers.get(`beforeCreate ${kind}`) ?? []) rec = h(rec, 'user')
			if (rec === prev) return
			map.set(rec.id, rec)
			writes.push(`${prev ? 'update' : 'create'} ${kind} ${rec.type}`)
			touch(kind, rec.id, prev, rec)
		})

	const pagePoint = (s: Ref): { x: number; y: number } => {
		const shape = shapes.get(idOf(s))
		if (!shape) return { x: 0, y: 0 }
		const parent = shapes.get(shape.parentId)
		const p = parent ? pagePoint(parent) : { x: 0, y: 0 }
		return { x: p.x + shape.x, y: p.y + shape.y }
	}
	const bindingsOf = (s: Ref, side: 'fromId' | 'toId', type?: string) =>
		[...bindings.values()].filter((b) => b[side] === idOf(s) && (!type || b.type === type))

	const removeBinding = (id: string) =>
		run(() => {
			const binding = bindings.get(id)
			if (!binding || call('beforeDelete binding', binding, 'user').includes(false)) return
			bindings.delete(id)
			writes.push(`delete binding ${binding.type}`)
			touch('binding', id, binding, undefined)
		})
	const removeShape = (id: string) => {
		const shape = shapes.get(id)
		if (!shape) return
		const involved = [...bindingsOf(id, 'fromId'), ...bindingsOf(id, 'toId')]
		for (const b of involved) {
			if (b.type === 'arrow' && b.toId === id) editor.updateShape({ id: b.fromId, props: { [b.props.terminal]: 'loose' } })
		}
		involved.forEach((b) => removeBinding(b.id))
		if (call('beforeDelete shape', shape, 'user').includes(false)) return
		shapes.delete(id)
		writes.push(`delete shape ${shape.type}`)
		touch('shape', id, shape, undefined)
	}

	const editor = {
		user: { getName: () => '', updateUserPreferences() {} },
		sideEffects: {
			registerBeforeCreateHandler: (kind: Kind, fn: Handler) => on(`beforeCreate ${kind}`, fn),
			registerAfterCreateHandler: (kind: Kind, fn: Handler) => on(`afterCreate ${kind}`, fn),
			registerBeforeChangeHandler: (kind: Kind, fn: Handler) => on(`beforeChange ${kind}`, fn),
			registerAfterChangeHandler: (kind: Kind, fn: Handler) => on(`afterChange ${kind}`, fn),
			registerBeforeDeleteHandler: (kind: Kind, fn: Handler) => on(`beforeDelete ${kind}`, fn),
			registerAfterDeleteHandler: (kind: Kind, fn: Handler) => on(`afterDelete ${kind}`, fn),
			registerOperationCompleteHandler: (fn: Handler) => on('operationComplete', fn),
		},
		run,
		on: (event: string, fn: Handler) => on(`event ${event}`, fn),
		off: (event: string, fn: Handler) => void handlers.set(`event ${event}`, (handlers.get(`event ${event}`) ?? []).filter((h) => h !== fn)),
		getContainer: () => ({ addEventListener() {}, removeEventListener() {} }),
		markHistoryStoppingPoint: () => 'mark',
		markEventAsHandled() {},
		isIn: (path: string) => tool === path || tool.startsWith(`${path}.`),
		setCurrentTool: (id: string) => void (tool = id.includes('.') ? id : `${id}.idle`),
		canEditShape: () => false,
		getSelectedShapeIds: () => selected,
		select: (...ids: string[]) => void (selected = ids),
		getCurrentPageId: () => PAGE,
		getCurrentPageShapes: () => [...shapes.values()],
		getShape: (s: Ref) => shapes.get(idOf(s)),
		findShapeAncestor: (s: Ref, match: (parent: FakeShape) => boolean) => {
			for (let p = shapes.get(shapes.get(idOf(s))?.parentId ?? ''); p; p = shapes.get(p.parentId)) if (match(p)) return p
			return undefined
		},
		isShapeHidden: () => false,
		getShapePageTransform: (s: Ref) => ({ point: () => pagePoint(s) }),
		getPointInParentSpace: (s: Ref, point: { x: number; y: number }) => {
			const parent = shapes.get(shapes.get(idOf(s))?.parentId ?? '')
			const p = parent ? pagePoint(parent) : { x: 0, y: 0 }
			return { x: point.x - p.x, y: point.y - p.y }
		},
		getShapePageBounds: (s: Ref) => {
			const shape = shapes.get(idOf(s))
			if (!shape) return undefined
			const { x, y } = pagePoint(shape)
			const { w = 1, h = 1, scale = 1 } = shape.props
			if (shape.type === 'paper-card') return new Box(x + w / 2 - CARD_SIZE.w / 2, y + h / 2 - CARD_SIZE.h / 2, CARD_SIZE.w, CARD_SIZE.h)
			if (shape.type === 'note') return new Box(x, y, 200 * scale, 200 * scale)
			return new Box(x, y, w, h)
		},
		createShape: (partial: Partial<FakeShape> & { type: string }) =>
			put('shape', { id: `shape:${++made}`, x: 0, y: 0, rotation: 0, parentId: PAGE, props: {}, meta: {}, ...partial }),
		updateShape: (partial: Partial<FakeShape> & { id: string }) => {
			const prev = shapes.get(partial.id)
			if (prev) put('shape', { ...prev, ...partial, props: { ...prev.props, ...partial.props }, meta: { ...prev.meta, ...partial.meta } })
		},
		// with everything inside them, named before anything goes, as tldraw does
		deleteShapes: (ids: Ref[]) => {
			const all = new Set(ids.map(idOf))
			for (const id of all) for (const s of shapes.values()) if (s.parentId === id) all.add(s.id)
			call('event deleted-shapes', [...all])
			run(() => all.forEach(removeShape))
		},
		reparentShapes: (ids: Ref[], parentId: string) =>
			run(() => {
				const p = shapes.has(parentId) ? pagePoint(parentId) : { x: 0, y: 0 }
				for (const id of ids.map(idOf)) {
					const at = pagePoint(id)
					editor.updateShape({ id, parentId, x: at.x - p.x, y: at.y - p.y })
				}
			}),
		getBindingsFromShape: (s: Ref, type?: string) => bindingsOf(s, 'fromId', type),
		getBindingsToShape: (s: Ref, type?: string) => bindingsOf(s, 'toId', type),
		createBinding: (partial: Partial<FakeBinding> & { type: string; fromId: string; toId: string }) =>
			put('binding', { id: `binding:${++made}`, props: {}, meta: {}, ...partial }),
		updateBinding: (partial: Partial<FakeBinding> & { id: string }) => {
			const prev = bindings.get(partial.id)
			if (prev) put('binding', { ...prev, ...partial, props: { ...prev.props, ...partial.props } })
		},
		deleteBinding: (id: string) => removeBinding(id),
	}
	for (const shape of initial) shapes.set(shape.id, { x: 0, y: 0, rotation: 0, parentId: PAGE, props: {}, meta: {}, ...shape })
	// `editor` for the code under test; `fake` for the test's own edits, with plain string IDs
	return { editor: editor as unknown as Editor, fake: editor, shapes, bindings, writes }
}
