# T01: Shared board model: custom shapes, bindings, IDs, attribution, human-touched flags

| Field | Value |
| --- | --- |
| Lane | Board + Browser |
| Size | M |
| Depends on | — |
| Unblocks | T02, T08, T09, T10, T13, T14 |
| Milestone | M2 |
| Status | Not started |
| Owner | TBD |

## Goal

The board knows what a paper is and draws it the way the [v4 mockup](../../mockups/README.md) does. A `paper-card` node, a pinned note binding and typed links are registered once and used by both the sync server and the browser; every shape says who made it; and the moment a person moves or edits an agent's shape, the shape is marked so no agent touches it again.

## Context

- **Visual spec:** [v4 mockup](../../mockups/README.md) (`docs/mockups/flashcard-v4.html`, screenshots in `docs/mockups/shots-v4/`): seeds and kept papers are white squares with a bookmark; suggestions are circles coloured by fit; a NEW badge; a dashed ring and "Agent is reading…" while the agent works; a check badge on kept papers; the label under each node is first author and year; clusters are pale frames with an upper-case title.
- [Concept: Canvas shapes](../../Concept.md#canvas-shapes) and [Collaboration: rules when people and agents edit at once](../../Concept.md#collaboration-on-the-board).
- v4's "What the UI needs from the backend": user edits stored with the board (moved positions, links with `label` and `by`, hidden citation links, notes pinned to a paper).
- Today `client/server/server.ts` builds its schema from `defaultShapeSchemas` only, so a custom shape written by anyone would be rejected.

## Scope

**In:** shared shape and binding definitions with migrations; server schema; the `paper-card` node rendering from v4; the `note-pin` binding; link (arrow) meta; ID and attribution helpers in TypeScript and Python; member identity; human-touched side effects; the per-viewer state atoms other WPs read (current goal, filters, open card).

**Out:** the card that opens beside a node (T10); the top and bottom bars (T13); drawing and editing links and pinning notes by hand (T14); cluster frame behaviour (T02 phase 2, meta keys fixed here).

## Design

**One module, two consumers.** `client/shared/` holds everything the server and the browser must agree on. It imports only `@tldraw/tlschema` and `@tldraw/validate` (add `@tldraw/validate` at the same 5.5.x version), never `tldraw` itself, which pulls React and CSS into Node.

| File | Contents |
| --- | --- |
| `client/shared/shapes.ts` | Props validators and migration sequences for each custom shape; `customShapeSchemas` |
| `client/shared/bindings.ts` | The `note-pin` binding's props and migrations; `customBindingSchemas` |
| `client/shared/ids.ts` | `paperShapeId(paperId)`, `agentShapeId(kind)`, `linkShapeId(from, to, kind)`, `slug()`, `RUN_ID_PATTERN` |
| `client/shared/meta.ts` | Types and helpers for `createdBy`, `onBehalfOf`, `runId`, `author`, `pinnedByHuman`, `editedByHuman`, link meta |
| `client/shared/display.ts` | `nodeLabel(authors, year)` ("Ibáñez-Molero 2026"), `sentenceCase(title)` for all-capital titles |
| `client/shared/fixtures/paper-ids.json` | `[[paperId, expectedShapeId], …]`, read by both TypeScript and Python tests |

**`paper-card` props.** Node fields drive the board; card fields fill the card beside it (T10). Both live on the shape so every part updates live through sync as the agent writes it (v4's "per-section progress").

| Group | Props |
| --- | --- |
| Identity | `paperId`, `title`, `authors` (list of display names), `year`, `venue`, `url`, `type` (`article`, `review`, `preprint` or `other`; normalised by T02 from what discovery emits, see below), `typeRaw` (the source's own value, for display), `peerReviewed` (boolean), `citedBy` (number or null) |
| Board state | `w`, `h`, `kind` (`seed`, `kept` or `suggestion`), `status` (`new`, `kept`, `contested`, `discarded`), `working` (boolean), `keepBy`, `discardBy` (member IDs; written only by the board service from votes, T08) |
| Fit per goal | `scores`: `{ [goal]: { score, fit: "low" \| "medium" \| "high", why } }`, one entry per "Looking for" goal (for example `new-findings`, `methods`) |
| Card first view | `figure` (`{imageUrl, caption, label}` or null; real figures only), `oneLine` (one sentence), `claims` (`[{text, evidence: [quoteId or "seeds"]}]`, the underlined phrases), `quotes` (`[{id, text, source, verified, url}]`), `facets` (`[{facet: "disease" \| "cells" \| "method", value, relation: "same" \| "adds" \| "other" \| "unclear", quoteId}]`) |
| Card details | `tldr`, `summary`, `gaps` (what couldn't be checked) |

Retracted papers are never written (T02 rejects them), so there is no `retracted` prop.

**Paper type values** (PR #6 review). Discovery emits `article` and `review` (PubMed, Semantic Scholar), `preprint` (arXiv, PubMed preprints) and OpenAlex's raw `work.type` (`article`, `review`, `preprint`, `book-chapter`, `dataset`, `letter`, `editorial` and more). `normaliseType(raw)` in `client/shared/display.ts` maps `article`, `review` and `preprint` to themselves and everything else to `other`, keeping the raw value in `typeRaw`. The validator accepts only the four normalised values; T02 normalises before writing. The UI's "Research" label (v4) means `article`.

**Rendering the node** (`PaperCardShapeUtil`, from v4):

| State | Look |
| --- | --- |
| `kind: seed` or `kept` | White rounded square with a bookmark icon; kept adds a check badge |
| `kind: suggestion` | Circle filled by `scores[currentGoal].fit`: dark blue high, mid blue medium, light blue low; grey if not scored yet |
| `status: new` | NEW badge |
| `working: true` | Dashed ring and "Agent is reading…" under the label |
| `status: contested` | Small split-vote mark |
| Size | Grows with the number of links (`w = h`, 40 to 72 px for circles, 48 to 80 px for squares) |
| Label | `nodeLabel(authors, year)` under the node; the title shows only in the card and the ranked list, in sentence case |
| Arrival | A new node fades and scales in, so papers visibly appear one at a time as the agent finds them (brainstorm, Oct 18) |

`currentGoal` and the active filters are per-viewer atoms (below), so two people can look at the same board for different goals.

**Links.** Built-in arrows bound to two cards, with meta: `kind` (`cites`, `similar` or `user`), `label` (text a person wrote, or empty), `by` (`agent`, `pubmed` or a member ID), `hiddenByHuman` (boolean). A `cites` link is a PubMed fact: people may label or hide it, never delete it. A `similar` link is the agent's guess: people may rename or delete it. ID: `linkShapeId(from, to, kind)`, so writing the same link twice is a no-op. Interaction and the "labels on hover" rule are in T14.

**Notes pinned to a paper.** A `note-pin` binding from a built-in note to a `paper-card`, following tldraw's [sticker bindings](https://tldraw.dev/examples/sticker-bindings) pattern: `onAfterChangeToShape` moves the note with the paper, `onBeforeDeleteToShape` unpins it (the note stays). The card's Notes section lists pinned notes (T10).

Cluster frames are built-in `frame` shapes with `meta.clusterId`, `meta.labelGenerated` and `meta.renamedByHuman`.

Each shape and binding gets an empty migration sequence now (`createShapePropsMigrationIds`, `createShapePropsMigrationSequence`, and the binding equivalents), so the first prop change later is a migration, not a broken room. TypeScript typing uses tldraw 5's `TLGlobalShapePropsMap` declaration merging. The `highlight` shape for PDF highlights is defined here too (`paperId`, `text`, `page`, `category`, `note`, `replies`, `rects`), used only if T10's PDF reading stays in scope.

**Server.** `createTLSchema({ shapes: { ...defaultShapeSchemas, ...customShapeSchemas }, bindings: { ...defaultBindingSchemas, ...customBindingSchemas } })` in `client/server/server.ts`.

**Browser.** `client/client/shapes/` holds `PaperCardShapeUtil`, `HighlightShapeUtil` and `NotePinBindingUtil`, exported as `customShapeUtils` and `customBindingUtils`. `Room.tsx` passes the same lists to `useSync({ …, shapeUtils: [...defaultShapeUtils, ...customShapeUtils], bindingUtils: [...defaultBindingUtils, ...customBindingUtils] })` and to `<Tldraw>`.

**Per-viewer state** (`client/client/viewerState.ts`, tldraw `atom`s, never written to the room): `currentGoal`, `filters` (T09), `openCardPaperId` (T10). Shape utils read them, so changing one re-renders only this browser.

**Identity.** `client/client/identity.ts`: `getMemberId()` returns `localStorage['pdc.memberId']`, creating `m_` plus 10 random characters on first use; `getDisplayName()` asks once and stores it, and sets the tldraw user name so cursors and the face pile show it.

**Attribution and human-touched flags** (side effects registered in `onMount`):

| Handler | Rule |
| --- | --- |
| `registerBeforeCreateHandler('shape', (shape, source))` | If `source === 'user'` and no `meta.createdBy`, set `meta.author = memberId` |
| `registerBeforeChangeHandler('shape', (prev, next, source))` | If `source === 'user'` and `prev.meta.createdBy === 'agent'`: a change to `x`, `y`, `rotation` or `parentId` sets `meta.pinnedByHuman = true`; a change to any prop sets `meta.editedByHuman = true` |

`source === 'remote'` changes (other people, the agent through the server) never set the flags, so the agent's own updates don't lock its cards. The same handlers count this viewer's edits for T13's "N changes · the agent is waiting".

**Hiding.** `<Tldraw getShapeVisibility={…}>` returns `'hidden'` for discarded cards unless "Show discarded papers" is on (T09's filter), and for links with `hiddenByHuman`.

## Tasks

- [ ] `client/shared/shapes.ts`, `bindings.ts`, `ids.ts`, `meta.ts`, `display.ts`, `fixtures/paper-ids.json` (include IDs with `:`, `/`, `.` and unicode).
- [ ] `client/package.json`: add `@tldraw/validate` pinned to the installed tldraw version; `client/tsconfig.json`: include `shared`.
- [ ] `client/server/server.ts`: custom shapes and bindings in the schema.
- [ ] `client/client/shapes/PaperCardShapeUtil.tsx` (v4 node look), `HighlightShapeUtil.tsx`, `NotePinBindingUtil.ts`, `index.ts`.
- [ ] `client/client/viewerState.ts`, `client/client/identity.ts`; display-name prompt on first visit.
- [ ] `client/client/pages/Room.tsx`: utils in `useSync` and `<Tldraw>`, side-effect handlers, `getShapeVisibility`.
- [ ] `client/server/addShape.ts`: a `paper` mode that writes one `paper-card`, as a living example.
- [ ] Tests (below).

## Acceptance criteria

1. `node server/addShape.ts <board> --paper pmid:34290406 "Some title"` puts a `paper-card` with ID `shape:paper-pmid_34290406` on the board, drawn as in v4, visible in two browsers; running it twice leaves one card.
2. A seed renders as a bookmark square; a suggestion with `scores.new-findings.fit = "high"` renders dark blue, and switching `currentGoal` to `methods` (where its fit is low) turns it light blue in this browser only.
3. Moving an agent's card in one browser sets `meta.pinnedByHuman`; editing it sets `meta.editedByHuman`. A server-side update does neither.
4. A note pinned to a card with a `note-pin` binding moves when the card moves, in every browser; deleting the card leaves the note, unpinned.
5. A link with `hiddenByHuman` is hidden for everyone; a discarded card is hidden until "Show discarded papers" is on, in that browser only.
6. All-capital titles display in sentence case; rooms saved before this change still open.

## Tests

- `client/shared/ids.test.ts`: every fixture pair; Python mirrors it in `harness/tests/test_board_ids.py` (T04) against the same file.
- `client/shared/display.test.ts`: `nodeLabel` (one author, "et al.", accents), `sentenceCase`, and `normaliseType` for every value the discovery sources emit plus an unknown OpenAlex type.
- `client/server/schema.test.ts`: the server schema validates one sample of each custom shape and binding and rejects a `paper-card` with a bad `fit`.
- `client/client/sideEffects.test.ts`: the flag rules as pure functions (`nextMeta(prev, next, source)`), so no DOM is needed.

Run with `node --test` from `client/`.

## Risks

- **Schema drift** between server and client: a client whose schema has a shape the server lacks can't connect. Both import `client/shared/`, and `schema.test.ts` fails if they diverge.
- **Flags on remote echoes:** check that the store reports changes from the sync server as `remote`; the pure-function test covers the rule, a two-browser check covers the wiring.
- **Props grow** as the card fills in (claims, quotes, facets): a few KB per paper is fine for a few hundred papers; long texts (summary) stay short by contract with the reader agent.

## References

- [v4 mockup and its README](../../mockups/README.md)
- [tldraw shapes](https://tldraw.dev/docs/shapes), [custom shape example](https://tldraw.dev/examples/custom-shape), [bindings](https://tldraw.dev/sdk-features/bindings), [sticker bindings example](https://tldraw.dev/examples/sticker-bindings)
- [tldraw side effects](https://tldraw.dev/sdk-features/side-effects), [tldraw sync](https://tldraw.dev/docs/sync)
- [Concept: Canvas shapes](../../Concept.md#canvas-shapes)
