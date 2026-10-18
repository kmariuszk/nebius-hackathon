// The server's schema knows the custom shapes and bindings (T01), so their records sync and
// rooms saved before them still open. Run with: node --test server/schema.test.ts
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import {
	createTLSchema,
	defaultBindingSchemas,
	defaultShapeSchemas,
	type TLRecord,
	type TLSchema,
	type TLShape,
} from '@tldraw/tlschema'
import type { IndexKey } from '@tldraw/utils'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'
import { customBindingSchemas, NOTE_PIN_TYPE } from '../shared/bindings.ts'
import { paperShapeId } from '../shared/ids.ts'
import { customShapeSchemas, defaultPaperCardProps } from '../shared/shapes.ts'

// built exactly as server.ts builds it
const schema = createTLSchema({
	shapes: { ...defaultShapeSchemas, ...customShapeSchemas },
	bindings: { ...defaultBindingSchemas, ...customBindingSchemas },
})

const dir = mkdtempSync(join(tmpdir(), 'schema-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const PAGE = 'page:page' as TLShape['parentId']
const PAPER = paperShapeId('pmid:34290406')

function paperCard(props: Record<string, unknown> = {}) {
	return schema.types.shape.create({
		id: PAPER,
		type: 'paper-card',
		parentId: PAGE,
		index: 'a1' as IndexKey,
		meta: { createdBy: 'agent', onBehalfOf: 'm_abcdefghij', runId: null, paperId: 'pmid:34290406' },
		props: defaultPaperCardProps('pmid:34290406', {
			title: 'Some title',
			authors: ['Ana Ibáñez-Molero', 'B. Smith'],
			year: 2021,
			type: 'article',
			typeRaw: 'journal-article',
			scores: { 'new-findings': { score: 0.82, fit: 'high', why: 'Same cells, new readout' } },
			figure: { imageUrl: 'https://example.org/f1.jpg', label: 'Fig. 1', caption: 'UMAP', captionByAi: false },
			quotes: [{ id: 'q1', text: 'We profiled…', source: 'abstract', verified: true, url: 'https://x#:~:text=We' }],
			claims: [{ text: 'new readout', evidence: ['q1', 'seeds'] }],
			glance: [{ label: 'Samples', text: '48 tumours', quoteId: 'q1', relation: 'same' }],
			provenance: { oneLine: { model: 'nvidia/Nemotron-3.5-Super-VL', at: 1760000000000 } },
			...props,
		} as never),
	})
}

test('a paper-card validates', () => {
	const shape = paperCard()
	assert.deepEqual(schema.types.shape.validate(shape), shape)
})

test('a paper-card with a bad fit or type is rejected', () => {
	const badFit = paperCard({ scores: { methods: { score: 0.1, fit: 'great', why: '' } } })
	assert.throws(() => schema.types.shape.validate(badFit), /fit/)
	const badType = paperCard({ type: 'journal-article' })
	assert.throws(() => schema.types.shape.validate(badType), /type/)
	const extra = paperCard({ facets: [] })
	assert.throws(() => schema.types.shape.validate(extra), /facets/)
})

test('a note-pin binding validates', () => {
	const binding = schema.types.binding.create({
		id: 'binding:pin1',
		type: NOTE_PIN_TYPE,
		fromId: 'shape:note1',
		toId: PAPER,
		props: { dx: 60, dy: -40 },
	})
	assert.deepEqual(schema.types.binding.validate(binding), binding)
	assert.throws(() => schema.types.binding.validate({ ...binding, props: { dx: 1 } }), /dy/)
})

function openRoom(file: string, roomSchema: TLSchema) {
	const db = new DatabaseSync(join(dir, file))
	const room = new TLSocketRoom<TLRecord, void>({
		schema: roomSchema,
		storage: new SQLiteSyncStorage<TLRecord>({ sql: new NodeSqliteWrapper(db) }),
	})
	return { room, close: () => (room.close(), db.close()) }
}

test('a room on SQLite opens with this schema and stores a paper-card', () => {
	const { room, close } = openRoom('new.db', schema)
	room.storage.transaction((txn) => txn.set(PAPER, schema.types.shape.validate(paperCard())))
	close()
	const reopened = openRoom('new.db', schema)
	const stored = reopened.room.getRecord(PAPER) as TLShape<'paper-card'>
	assert.equal(stored.props.paperId, 'pmid:34290406')
	reopened.close()
})

test('a room saved before the custom shapes still opens', () => {
	const oldSchema = createTLSchema({ shapes: defaultShapeSchemas, bindings: defaultBindingSchemas })
	const old = openRoom('old.db', oldSchema)
	const page = old.room.getCurrentSnapshot().documents.some((d) => d.state.typeName === 'page')
	assert.ok(page)
	old.close()
	const reopened = openRoom('old.db', schema)
	assert.ok(reopened.room.getCurrentSnapshot().documents.length > 0)
	reopened.close()
})
