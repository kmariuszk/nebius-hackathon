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

The board knows what a paper is and draws it the way the [v5 mockup](../../mockups/README.md) does. A `paper-card` node, a pinned note binding and typed links are registered once and used by both the sync server and the browser; every shape says who made it; and the moment a person moves or edits an agent's shape, the shape is marked so no agent touches it again.

## Context

- **Visual spec:** [v5 mockup](../../mockups/README.md) (`docs/mockups/flashcard-v5.html`, screenshots in `docs/mockups/shots-v5/`), which keeps v4's nodes (`flashcard-v4.html`, `shots-v4/`): seeds and kept papers are white squares with a bookmark; suggestions are circles coloured by fit; a NEW badge; a dashed ring and "Agent is reading…" while the agent works; a check badge on kept papers; the label under each node is first author and year; clusters are pale frames with an upper-case title. v5 adds a ring around the open paper's node, with its widgets around it (T10), and lit papers (`3-peek.png`).
- [Concept: Canvas shapes](../../Concept.md#canvas-shapes) and [Collaboration: rules when people and agents edit at once](../../Concept.md#collaboration-on-the-board).
- v4's "What the UI needs from the backend": user edits stored with the board (moved positions, links with `label` and `by`, hidden citation links, notes pinned to a paper).
- **In place on `feat/board-build`:** `client/shared/paperCard.ts` (the props), `ids.ts`, `display.ts`, `meta.ts` and `fixtures/paper-ids.json` with their tests; the note-pin props in `bindings.ts`; `client/client/viewerState.ts` and `identity.ts`; and the hooks this WP fills in: `client/shared/shapes.ts` and `bindings.ts` (empty schemas the server already merges into its own), `client/client/shapes/index.ts` (`customShapeUtils`, `customBindingUtils`, `getShapeVisibility`) and `client/client/sideEffects.ts` (`registerBoardSideEffects`), all wired into `Room.tsx` and `server.ts`.

## Scope

**In:** shared shape and binding definitions with migrations; server schema; the `paper-card` node rendering from v5; the `note-pin` binding; link (arrow) meta; ID and attribution helpers in TypeScript and Python; member identity; human-touched side effects; the per-viewer state atoms other WPs read (current goal, filters, the open paper, More, lit papers).

**Out:** the widgets that open around a node (T10); the top and bottom bars (T13); drawing and editing links and pinning notes by hand (T14); cluster frame behaviour (T02 phase 2, meta keys fixed here); the `highlight` shape (deferred with T10's PDF reading).

## Design

**One module, two consumers.** `client/shared/` holds everything the server and the browser must agree on. It imports only `@tldraw/tlschema` and `@tldraw/validate` (add `@tldraw/validate` at the same 5.5.x version), never `tldraw` itself, which pulls React and CSS into Node.

| File | Contents |
| --- | --- |
| `client/shared/paperCard.ts` | The `paper-card` props as TypeScript types (`PaperCardProps`, `GoalScore`, `PaperFigure`, `PaperQuote`, `PaperClaim`, `GlanceStep`, `FieldProvenance`) and `PAPER_CARD_TYPE`: the source of truth for T01's validators, T02's tools and T10's widgets |
| `client/shared/shapes.ts` | Props validators and migration sequences for each custom shape, following `paperCard.ts`; `customShapeSchemas` |
| `client/shared/bindings.ts` | The `note-pin` binding's props (`NotePinProps`: `{dx, dy}`) and migrations; `NOTE_PIN_TYPE`, `customBindingSchemas` |
| `client/shared/ids.ts` | `paperShapeId(paperId)`, `isPaperShapeId(id)`, `agentShapeId(kind)`, `linkShapeId(from, to, kind)`, `slug()`, `randomHex()`, `RUN_ID_PATTERN` |
| `client/shared/meta.ts` | Types for `createdBy`, `onBehalfOf`, `runId`, `via`, `author`, `pinnedByHuman`, `editedByHuman`, link meta and cluster meta; `isAgentShape`, `isHumanTouched` |
| `client/shared/display.ts` | `familyName(author)` ("van der Berg"), `nodeLabel(authors, year)` ("Ibáñez-Molero 2026"), `shortAuthors(authors)` ("Tirosh", "Tirosh and Izar", "Tirosh et al."), `sentenceCase(title)` for all-capital titles, `normaliseType(raw)` |
| `client/shared/fixtures/paper-ids.json` | `[[paperId, expectedShapeId], …]`, read by both TypeScript and Python tests |

**`paper-card` props.** `client/shared/paperCard.ts` is the source of truth; the table below summarises it. Changing a field there changes T01's validators, T02's tools and T10's widgets, plus a migration in `shapes.ts`. Node fields drive the board; widget fields fill the widgets around the node when it's opened (T10). Both live on the shape so every widget updates live through sync as the agent writes it (v4's "per-section progress").

| Group | Props |
| --- | --- |
| Identity | `paperId`, `title`, `authors` (display names, first author first), `year` (number or null), `venue`, `url`, `type` (`article`, `review`, `preprint` or `other`; normalised by T02 from what discovery emits, see below), `typeRaw` (the source's own value, for display), `peerReviewed` (true, false for preprints, or null when unknown), `citedBy` (number or null) |
| Board state | `w`, `h`, `kind` (`seed`, `kept` or `suggestion`), `status` (`new`, `kept`, `contested`, `discarded`), `working` (boolean, "Agent is reading…"), `keepBy`, `discardBy` (member IDs, from votes: the board service writes them once T08 exists, T10 through the editor until then; a vote also sets `status`, and `kind` follows it between `suggestion` and `kept`) |
| Fit per goal | `scores`: `{ [goal]: { score, fit: "low" \| "medium" \| "high", why } }`, one entry per "Looking for" goal (for example `new-findings`, `methods`); `why` is the ranked list's line |
| The widgets (v5) | `figure` (`{imageUrl, label, caption, captionByAi}` or null; real figures only; `captionByAi` is true when the agent wrote the caption, which then gets an "AI" tag); `oneLine` and `claims` ("Why it matters to you": `oneLine` is written for the board's question, `claims` are `[{text, evidence: [quoteId or "seeds"]}]`, phrases that appear verbatim in `oneLine` and get underlined); `quotes` (`[{id, text, source, verified, url}]`); `glance` ("The paper at a glance": 3–4 steps `[{label, text, quoteId, relation}]`, `quoteId` a quote ID or null, `relation` `same`, `adds`, `other` or null; empty until the agent has read the paper) |
| Under More | `summary`; `gaps` (what couldn't be checked); `foundBy` (how the paper was found, as discovery reports it, for example `pubmed`, `cites 3 seeds`) |
| Provenance | `provenance`: `{ [prop]: {model, at} }` for each field the agent wrote with `set_card` (T02, from `X-Model`); `model` may be null, `at` is milliseconds since the epoch |

v5 dropped v4's `facets` and `tldr`: `glance` replaces both (decision D22). Retracted papers are never written (T02 rejects them), so there is no `retracted` prop.

**Paper type values** (PR #6 review). Discovery emits `article` and `review` (PubMed, Semantic Scholar), `preprint` (arXiv, PubMed preprints) and OpenAlex's raw `work.type` (`article`, `review`, `preprint`, `book-chapter`, `dataset`, `letter`, `editorial` and more). `normaliseType(raw)` in `client/shared/display.ts` maps `article`, `review` and `preprint` to themselves and everything else to `other`, keeping the raw value in `typeRaw`. The validator accepts only the four normalised values; T02 normalises before writing. The filter's "Research" (v4) covers `article`, `preprint` and `other`, and "Review" is `review` (T09).

**Rendering the node** (`PaperCardShapeUtil`, v5; the node look is v4's):

| State | Look |
| --- | --- |
| `kind: seed` or `kept` | White rounded square with a bookmark icon; kept adds a check badge |
| `kind: suggestion` | Circle filled by `scores[currentGoal].fit`: dark blue high, mid blue medium, light blue low; grey if not scored yet |
| `status: new` | NEW badge |
| `working: true` | Dashed ring and "Agent is reading…" under the label |
| `status: contested` | Small split-vote mark |
| Open (`openPaperId`) | A dark ring around the node; T10's widgets sit around it |
| Lit (`litPaperIds`) | A blue outline, on this screen only: hovering "three of your seeds" (T10) or `_canvas/highlight` (T06) |
| Size | Grows with the number of links (`w = h`, 40 to 72 px for circles, 48 to 80 px for squares) |
| Label | `nodeLabel(authors, year)` under the node; the title shows only in the widgets and the ranked list, in sentence case |
| Arrival | A new node fades and scales in, so papers visibly appear one at a time as the agent finds them (brainstorm, Oct 18) |

**Clicking.** `onClick` sets `openPaperId` to the node's `paperId`, which opens T10's widgets. Clicking the node that is already open toggles `paperMoreOpen` (T10's More) instead.

`currentGoal`, the active filters, the open paper and lit papers are per-viewer atoms (below), so two people can look at the same board differently.

**Links.** Built-in arrows bound to two cards, with meta: `kind` (`cites`, `similar` or `user`), `label` (text a person wrote, or empty), `by` (`agent`, `pubmed` or a member ID), `hiddenByHuman` (boolean). A `cites` link is a PubMed fact: people may label or hide it, never delete it. A `similar` link is the agent's guess: people may rename or delete it. ID: `linkShapeId(from, to, kind)`, which is `shape:link-<kind>-<slug(from)>--<slug(to)>`, so writing the same link twice is a no-op. Interaction and the "labels on hover" rule are in T14.

**Notes pinned to a paper.** A `note-pin` binding from a built-in note (`fromId`) to a `paper-card` (`toId`), following tldraw's [sticker bindings](https://tldraw.dev/examples/sticker-bindings) pattern. Its props are `{dx, dy}`: the note's top-left minus the paper's top-left, in page space. `onAfterChangeToShape` moves the note with the paper, keeping `dx` and `dy`; `onBeforeDeleteToShape` unpins it (the note stays). A note dropped on the paper or on any of its open widgets is pinned the same way (T10, T14), and the paper's Team notes widget lists its pinned notes (T10).

Cluster frames are built-in `frame` shapes with `meta.clusterId`, `meta.labelGenerated` and `meta.renamedByHuman`.

Each shape and binding gets an empty migration sequence now (`createShapePropsMigrationIds`, `createShapePropsMigrationSequence`, and the binding equivalents), so the first prop change later is a migration, not a broken room. TypeScript typing uses tldraw 5's `TLGlobalShapePropsMap` declaration merging. The `highlight` shape for PDF highlights (`paperId`, `text`, `page`, `category`, `note`, `replies`, `rects`) is deferred with T10's PDF reading: it's added here only if Phase B goes ahead.

**Server.** `client/server/server.ts` already builds `createTLSchema({ shapes: { ...defaultShapeSchemas, ...customShapeSchemas }, bindings: { ...defaultBindingSchemas, ...customBindingSchemas } })`; this WP fills the two shared lists.

**Browser.** `client/client/shapes/` holds `PaperCardShapeUtil` and `NotePinBindingUtil` (and `HighlightShapeUtil` only with Phase B), exported from `index.ts` as `customShapeUtils` and `customBindingUtils`, next to `getShapeVisibility`. `Room.tsx` already passes them to `useSync({ …, shapeUtils: [...defaultShapeUtils, ...customShapeUtils], bindingUtils: [...defaultBindingUtils, ...customBindingUtils] })` and to `<Tldraw>`.

**Per-viewer state** (`client/client/viewerState.ts`, tldraw `atom`s, never written to the room; in place): `currentGoal`, `filters` (T09), `openPaperId` and `paperMoreOpen` (T10), `litPaperIds` (T06, T10). Shape utils read them, so changing one re-renders only this browser.

**Identity.** `client/client/identity.ts`: `getMemberId()` returns `localStorage['pdc.memberId']`, creating `m_` plus 10 random characters on first use (in place); `getDisplayName()` asks once and stores it, and sets the tldraw user name so cursors and the face pile show it.

**Attribution and human-touched flags** (`registerBoardSideEffects(editor, memberId)` in `client/client/sideEffects.ts`, called from `onMount` in `Room.tsx`; it returns a function that removes the handlers):

| Handler | Rule |
| --- | --- |
| `registerBeforeCreateHandler('shape', (shape, source))` | If `source === 'user'` and no `meta.createdBy`, set `meta.author = memberId` |
| `registerBeforeChangeHandler('shape', (prev, next, source))` | If `source === 'user'` and `prev.meta.createdBy === 'agent'`: a change to `x`, `y`, `rotation` or `parentId` sets `meta.pinnedByHuman = true`; a change to any other prop sets `meta.editedByHuman = true`, except the vote and board-state props (`status`, `kind`, `keepBy`, `discardBy`) and `w`/`h` |

So a Keep or Discard, or a node resized by its link count, never locks a paper for the agent. `source === 'remote'` changes (other people, the agent through the server) never set the flags, so the agent's own updates don't lock its cards. The same handlers count this viewer's edits for T13's "N changes · the agent is waiting".

**Hiding.** `getShapeVisibility` (passed to `<Tldraw>`) returns `'hidden'` for discarded papers unless "Show discarded papers" is on (T09's filter), and for links with `hiddenByHuman`.

## Tasks

- [x] `client/shared/paperCard.ts`, `ids.ts`, `meta.ts`, `display.ts`, `fixtures/paper-ids.json` (IDs with `:`, `/`, `.` and unicode), with `ids.test.ts` and `display.test.ts` (on `feat/board-build`).
- [ ] `client/shared/shapes.ts` and `bindings.ts`: validators and migrations for `paper-card` and `note-pin`.
- [x] `client/package.json`: `@tldraw/validate` pinned to 5.5.2; `client/tsconfig.json`: include `shared`.
- [x] `client/server/server.ts`: custom shapes and bindings merged into the schema.
- [ ] `client/client/shapes/PaperCardShapeUtil.tsx` (v5 node look, open and lit states, click), `NotePinBindingUtil.ts`, `index.ts`.
- [x] `client/client/viewerState.ts`, `client/client/identity.ts` (`getMemberId`).
- [ ] Display-name prompt on first visit (`getDisplayName`).
- [x] `client/client/pages/Room.tsx`: utils in `useSync` and `<Tldraw>`, the side-effect hook, `getShapeVisibility`.
- [ ] `client/client/sideEffects.ts`: the handlers above.
- [ ] `client/server/addShape.ts`: a `paper` mode that writes one `paper-card`, as a living example.
- [ ] Tests (below).

## Acceptance criteria

1. `node server/addShape.ts <board> --paper pmid:34290406 "Some title"` puts a `paper-card` with ID `shape:paper-pmid_34290406` on the board, drawn as in v5, visible in two browsers; running it twice leaves one card.
2. A seed renders as a bookmark square; a suggestion with `scores.new-findings.fit = "high"` renders dark blue, and switching `currentGoal` to `methods` (where its fit is low) turns it light blue in this browser only.
3. Clicking a node sets `openPaperId` in this browser only; clicking it again toggles `paperMoreOpen`. Setting `litPaperIds` outlines those nodes in this browser only.
4. Moving an agent's paper in one browser sets `meta.pinnedByHuman`; editing its title sets `meta.editedByHuman`; a Keep (`status`, `keepBy`) or a resize sets neither. A server-side update does neither.
5. A note pinned to a paper with a `note-pin` binding moves when the paper moves, keeping its `dx` and `dy`, in every browser; deleting the paper leaves the note, unpinned.
6. A link with `hiddenByHuman` is hidden for everyone; a discarded paper is hidden until "Show discarded papers" is on, in that browser only.
7. All-capital titles display in sentence case; rooms saved before this change still open.

## Tests

- `client/shared/ids.test.ts` (in place): every fixture pair and link IDs; Python mirrors it in `harness/tests/test_board_ids.py` (T04) against the same file.
- `client/shared/display.test.ts` (in place): `nodeLabel` (one author, particles, accents), `shortAuthors`, `sentenceCase`, and `normaliseType` for every value the discovery sources emit plus an unknown OpenAlex type.
- `client/server/schema.test.ts`: the server schema validates one sample of each custom shape and binding and rejects a `paper-card` with a bad `fit` or a glance step with a bad `relation`.
- `client/client/sideEffects.test.ts`: the flag rules as pure functions (`nextMeta(prev, next, source)`), including vote props and `w`/`h` leaving `editedByHuman` unset, so no DOM is needed.

Run with `pnpm test` (`node --test` over `server/`, `shared/` and `client/`) from `client/`.

## Risks

- **Schema drift** between server and client: a client whose schema has a shape the server lacks can't connect. Both import `client/shared/`, and `schema.test.ts` fails if they diverge.
- **Flags on remote echoes:** check that the store reports changes from the sync server as `remote`; the pure-function test covers the rule, a two-browser check covers the wiring.
- **Props grow** as the widgets fill in (claims, quotes, glance): a few KB per paper is fine for a few hundred papers; long texts (summary) stay short by contract with the reader agent.

## References

- [v5 mockup and its README](../../mockups/README.md) (v4 in the same README)
- [tldraw shapes](https://tldraw.dev/docs/shapes), [custom shape example](https://tldraw.dev/examples/custom-shape), [bindings](https://tldraw.dev/sdk-features/bindings), [sticker bindings example](https://tldraw.dev/examples/sticker-bindings)
- [tldraw side effects](https://tldraw.dev/sdk-features/side-effects), [tldraw sync](https://tldraw.dev/docs/sync)
- [Concept: Canvas shapes](../../Concept.md#canvas-shapes)
