# T01: Shared board model: custom shapes, IDs, attribution, human-touched flags

| Field | Value |
| --- | --- |
| Lane | Board + Browser |
| Size | M |
| Depends on | — |
| Unblocks | T02, T08, T09, T10 |
| Milestone | M2 |
| Status | Not started |
| Owner | TBD |

## Goal

The board knows what a paper is. A `paper-card` and its companions (`highlight`, `quote`, `figure`) are registered once and used by both the sync server and the browser; every shape says who made it; and the moment a person moves or edits an agent's shape, the shape is marked so no agent touches it again.

## Context

- [Concept: Canvas shapes](../../Concept.md#canvas-shapes) and [Canvas layout rules](../../Concept.md#system-architecture) list the shapes and their props; [Collaboration: rules when people and agents edit at once](../../Concept.md#collaboration-on-the-board) sets the human-touched rule.
- [Architecture diagram 4](../../architecture.html#model): cards, notes, highlights and quotes live as shapes in the sync room.
- Today `client/server/server.ts` builds its schema from `defaultShapeSchemas` only, and `client/client/pages/Room.tsx` passes no custom shape utils, so a custom shape written by anyone would be rejected.

## Scope

**In:** shared shape definitions and migrations; server schema; client shape utils with plain, readable rendering; ID and attribution helpers in TypeScript and Python; member identity in the browser; human-touched side effects; hiding discarded cards per viewer.

**Out:** final visual design from the mockups (see open question in the group README); the `table` shape (T02 phase 2); cluster frames' behaviour (T02 phase 2, but the meta keys are fixed here).

## Design

**One module, two consumers.** `client/shared/` holds everything the server and the browser must agree on. It imports only `@tldraw/tlschema` and `@tldraw/validate` (add `@tldraw/validate` at the same 5.5.x version), never `tldraw` itself, which pulls React and CSS into Node.

| File | Contents |
| --- | --- |
| `client/shared/shapes.ts` | Props validators and migration sequences for each custom shape; `customShapeSchemas` for `createTLSchema` |
| `client/shared/ids.ts` | `paperShapeId(paperId)`, `agentShapeId(kind)`, `slug()`, `RUN_ID_PATTERN` |
| `client/shared/meta.ts` | Types and helpers for `createdBy`, `onBehalfOf`, `runId`, `author`, `pinnedByHuman`, `editedByHuman` |
| `client/shared/fixtures/paper-ids.json` | `[[paperId, expectedShapeId], …]`, read by both TypeScript and Python tests |

`client/tsconfig.json` adds `shared` to `include`.

**Custom shapes.**

| Shape | Props | Rendering (v1, plain) |
| --- | --- | --- |
| `paper-card` | `w`, `h`, `paperId`, `title`, `authors` (short form), `year` (number or null), `venue`, `url`, `kind` (`seed` or `suggestion`), `status` (`new`, `kept`, `contested`, `discarded`), `rating` (0 to 1 or null), `fit` (`low`, `medium`, `high` or null), `reason`, `tldr`, `summary`, `whyItMatters`, `working` (boolean), `keepBy` and `discardBy` (member IDs, written only by the board service from votes, T08) | Seeds and kept papers are rectangles, suggestions are circles (`Ellipse2d` geometry); fill colour by `fit`; badges for New, Working, Kept, Contested; voters' avatars; title and year always visible, `tldr` when zoomed in |
| `highlight` | `w`, `h`, `paperId`, `text`, `page` (number or null), `category` (string or null), `note`, `replies` (`[{author, text, at}]`), `rects` (`[{x, y, w, h}]`, normalised to the page) | A coloured strip with the passage, the category label and the note's first line |
| `quote` | `w`, `h`, `paperId`, `text`, `section`, `verified` (boolean), `url` (with a `#:~:text=` fragment) | Serif text with an "exact match" or "not found" tag; clicking opens `url` |
| `figure` | `w`, `h`, `paperId`, `figureId`, `imageUrl`, `caption`, `why` | Image with caption |

Cluster frames are built-in `frame` shapes with `meta.clusterId`, `meta.labelGenerated` and `meta.renamedByHuman`.

Each shape gets an empty migration sequence now (`createShapePropsMigrationIds`, `createShapePropsMigrationSequence`), so the first prop change later is a migration, not a broken room. TypeScript typing uses tldraw 5's `TLGlobalShapePropsMap` declaration merging.

**Server.** `createTLSchema({ shapes: { ...defaultShapeSchemas, ...customShapeSchemas } })` in `client/server/server.ts`; bindings stay the defaults (arrows bind to cards).

**Browser.** `client/client/shapes/` holds one `ShapeUtil` per custom shape (`BaseBoxShapeUtil` subclasses reading `props` and `migrations` from `client/shared/shapes.ts`) and exports `customShapeUtils`. `Room.tsx` passes the same list to `useSync({ …, shapeUtils: [...defaultShapeUtils, ...customShapeUtils] })` and to `<Tldraw shapeUtils={customShapeUtils} />`.

**Identity.** `client/client/identity.ts`: `getMemberId()` returns `localStorage['pdc.memberId']`, creating `m_` plus 10 random characters on first use; `getDisplayName()` asks once and stores it, and sets the tldraw user name so cursors show it.

**Attribution and human-touched flags** (side effects registered in `onMount`):

| Handler | Rule |
| --- | --- |
| `registerBeforeCreateHandler('shape', (shape, source))` | If `source === 'user'` and no `meta.createdBy`, set `meta.author = memberId` |
| `registerBeforeChangeHandler('shape', (prev, next, source))` | If `source === 'user'` and `prev.meta.createdBy === 'agent'`: a change to `x`, `y`, `rotation` or `parentId` sets `meta.pinnedByHuman = true`; a change to any prop sets `meta.editedByHuman = true` |

`source === 'remote'` changes (other people, the agent through the server) never set the flags, so the agent's own updates don't lock its cards.

**Hiding discarded cards per viewer.** `<Tldraw getShapeVisibility={…}>` returns `'hidden'` for `paper-card` with `status === 'discarded'` unless this viewer has "Show discarded" on (a local atom; the toggle lives in the legend, T09).

## Tasks

- [ ] `client/shared/shapes.ts`, `ids.ts`, `meta.ts`, `fixtures/paper-ids.json` (include IDs with `:`, `/`, `.` and unicode).
- [ ] `client/package.json`: add `@tldraw/validate` pinned to the installed tldraw version; `client/tsconfig.json`: include `shared`.
- [ ] `client/server/server.ts`: custom shapes in the schema.
- [ ] `client/client/shapes/PaperCardShapeUtil.tsx`, `HighlightShapeUtil.tsx`, `QuoteShapeUtil.tsx`, `FigureShapeUtil.tsx`, `index.ts`.
- [ ] `client/client/identity.ts`; display-name prompt on first visit.
- [ ] `client/client/pages/Room.tsx`: shape utils in `useSync` and `<Tldraw>`, side-effect handlers, `getShapeVisibility`.
- [ ] `client/server/addShape.ts`: add a `paper` mode that writes one `paper-card`, as a living example.
- [ ] Tests (below).

## Acceptance criteria

1. `node server/addShape.ts <board> --paper pmid:34290406 "Some title"` puts a `paper-card` with ID `shape:paper-pmid_34290406` on the board, visible in two browsers; running it twice leaves one card.
2. Moving that card in one browser sets `meta.pinnedByHuman` (visible in the other browser's store); editing its title sets `meta.editedByHuman`. A server-side update to it does neither.
3. A sticky note made by a person carries `meta.author` with that browser's `memberId`.
4. A card with `status: "discarded"` is hidden until "Show discarded" is on, in that browser only.
5. Rooms saved before this change still open.

## Tests

- `client/shared/ids.test.ts`: every fixture pair; Python mirrors it in `harness/tests/test_board_ids.py` (T04) against the same file.
- `client/server/schema.test.ts`: the server schema validates one sample of each custom shape and rejects a `paper-card` with a bad `fit`.
- `client/client/sideEffects.test.ts`: the flag rules as pure functions (`nextMeta(prev, next, source)`), so no DOM is needed.

Run with `node --test` from `client/`.

## Risks

- **Schema drift** between server and client: a client whose schema has a shape the server lacks can't connect. Both import `client/shared/shapes.ts`, and `schema.test.ts` fails if they diverge.
- **Flags on remote echoes:** check that the store reports changes from the sync server as `remote`, so a person's own edit coming back doesn't double-count; the pure-function test covers the rule, a two-browser check covers the wiring.

## References

- [tldraw shapes](https://tldraw.dev/docs/shapes) and the [custom shape example](https://tldraw.dev/examples/custom-shape)
- [tldraw side effects](https://tldraw.dev/sdk-features/side-effects)
- [tldraw sync](https://tldraw.dev/docs/sync)
- [Concept: Canvas shapes](../../Concept.md#canvas-shapes)
