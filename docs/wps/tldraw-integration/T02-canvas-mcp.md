# T02: Canvas MCP and layout service

| Field | Value |
| --- | --- |
| Lane | Board |
| Size | M |
| Depends on | T01 |
| Unblocks | T12, T11, the harness owner's agents |
| Milestone | M2 |
| Status | Not started |
| Owner | TBD |

## Goal

Any agent changes the shared board only by calling MCP tools at `/api/mcp/canvas/:boardId`. Each call is one atomic write into the board's `TLSocketRoom`, so every open browser sees it at once and agents work with nobody watching. Agents never give coordinates: the layout service puts each new card next to its most similar neighbour without overlapping anything.

## Context

- [Architecture diagram 1](../../architecture.html#components): "Canvas MCP + layout service" writes into the sync rooms; external agents use the same server.
- [Concept: Canvas MCP tools](../../Concept.md#apis-and-data-model) is the full tool list; this WP builds the ones that need only the board, and [I5](interfaces.md#i5-what-the-board-service-needs-from-the-papers-mcp) gates the rest.
- `client/server/server.ts` already writes validated shapes in one `room.storage.transaction` (`putShapes`) for `POST /api/rooms/:room/shapes`.

## Scope

**In:** MCP server over streamable HTTP; v1 tools below; attribution from headers; human-touched rules; idempotent writes; layout v0 (neighbour placement); closing rooms opened only for agent writes; an event hook for T08.

**Out (phase 2, once the discovery tools exist):** `apply_clusters`, `label_cluster`, `add_table`, `add_diagram`, the d3-force "Structure by" layout ([Concept: Clustering and layout](../../Concept.md#system-architecture)). Figures arrive through `set_card` once `get_figures` exists. The v4 mockup puts quotes and figures inside the card, not on the board, so there are no `quote` or `figure` shapes.

## Design

**Files.**

| File | Contents |
| --- | --- |
| `client/server/rooms.ts` | `getRoom`, `readRoom(boardId, fn)`, `writeRoom(boardId, fn)` (one transaction), idle close; moved out of `server.ts` |
| `client/server/canvasMcp.ts` | `handleCanvasMcp(req, res, boardId)`: builds an `McpServer` with the tools and a stateless `StreamableHTTPServerTransport` per request |
| `client/server/canvasTools.ts` | The tool handlers as plain functions `(ctx, input) => output`, testable without MCP |
| `client/server/layout.ts` | `placeNear(records, size, anchor)` and helpers |
| `client/server/papersClient.ts` | Cached `get_paper` calls to the papers MCP (also used by T08) |

**Server.** `@modelcontextprotocol/sdk` 1.32.1 with `zod` 4.6.5. Stateless mode (`sessionIdGenerator: undefined`): no MCP session state to lose on restart. Routes `POST`, `GET` and `DELETE` on `/api/mcp/canvas/:boardId` go to `transport.handleRequest(req, res, body)`. The server's `instructions` field states the board rules from [I4](interfaces.md#i4-how-agents-use-the-canvas), because external agents don't get our system prompt.

**Request context.**

| Source | Becomes |
| --- | --- |
| `Authorization: Bearer <memberId or personal token>` | `onBehalfOf` (personal tokens resolve to a member in T11); missing or unknown gives HTTP 401 |
| `X-Run-Id: run_…` | `runId` on every shape written; missing is allowed (`null`) for external agents |
| `X-Model: nvidia/…` | Recorded with the time for each card field `set_card` writes, for the card's "AI" labels (T10); missing is allowed |
| URL `:boardId` | The room; created on first write like any room today |

**Tools (v1).**

| Tool | Input | Output | Rules |
| --- | --- | --- | --- |
| `get_board` | none | `{boardId, question, goals, papers: [{paperId, label, title, year, type, kind, status, scores, working, cluster, humanTouched, pinnedNotes}], links: [{from, to, kind, label, by}], notes: [{shapeId, text, author, pinnedTo}], discardedIds, removedLinks}` | Compact, never raw records; `question`, `goals`, `discardedIds` and `removedLinks` come from T08's board DB and are empty before it exists; capped at 500 papers |
| `add_papers` | `{papers: [{paperId, title, authors?, year?, venue?, url?, type?, peerReviewed?, citedBy?, retracted?, kind?, near?}]}`, at most 50 | `{added, updated, skipped: [{paperId, reason}]}` | ID from `paperShapeId`; retracted papers and seeds already on the board are skipped; an existing card is updated in place unless human-touched (`skipped`, reason `edited by a person`); `status` starts `new`, `working` starts true |
| `set_scores` | `{paperId, scores: {[goal]: {score, fit, why}}}` | `{ok, skipped}` | `score` 0 to 1; `goal` must be one of the board's goals; the node colour and ranked list follow it |
| `set_card` | `{paperId, oneLine?, claims?, facets?, figure?, tldr?, summary?, gaps?}` | `{ok, skipped}` | Fills the card's first view and Details (T10); each field can arrive on its own, so the card fills in section by section; `claims[].evidence` must name quote IDs that exist on the card (or `seeds`); `figure` needs an `imageUrl` from the paper (no generated images) |
| `add_quote` | `{paperId, text, source?}` | `{quoteId}` or an MCP tool error | Adds to the card's `quotes`; rejected unless `text` appears verbatim (whitespace-normalised) in the paper's abstract, or full text once `get_fulltext` exists; the stored `url` gets a `#:~:text=` fragment |
| `link_papers` | `{links: [{from, to, kind, label?}]}`, `kind` one of `cites`, `similar` | `{linked, skipped}` | Arrow with two bindings, ID from `linkShapeId`, so repeats are no-ops; both cards must exist; skipped if a person removed the same link (`removedLinks`) or hid it; resizes cards by link count unless human-touched |
| `mark_working` | `{paperIds, on}` | `{ok}` | The "Agent is reading…" ring |
| `add_note` | `{text, paperId?}` | `{shapeId}` | Built-in note, authored as the agent; with `paperId` it is pinned to that card with a `note-pin` binding (T01) and appears in the card's Notes |
| `add_highlight` | `{paperId, text, page?, category?, note?}` | `{shapeId}` | Only if T10's PDF reading is in scope: `highlight` shape beside its card; no `rects` (the PDF view anchors it by text) |

Every write sets the meta from the [shared contracts](README.md#shared-contracts). Tool descriptions are self-contained (an external agent reads only them) and name their limits.

**Human-touched rules, enforced here.** Never change `x`, `y` or `parentId` of a shape with `pinnedByHuman`; never change props of a shape with `editedByHuman`; never touch a shape without `meta.createdBy === "agent"` except to bind an arrow or a pinned note to it; never delete; never recreate a link a person removed, or relabel or unhide one a person labelled or hid (v4: "you edit, then the agent catches up").

**Layout v0.** `placeNear` is deterministic and runs inside the write transaction:

1. Anchor: the `near` card's centre; else the most recent card from the same run; else just right of the page's content bounds.
2. Candidates: rings around the anchor at radius `k × (size + 40)`, 8 angles per ring, nearest first.
3. Take the first candidate whose box (plus a 24 px margin) overlaps no shape box on the page. Server-side boxes come from `x`, `y` and `w`/`h` props (notes count as 200 × `scale`; arrows are ignored).
4. A batch places cards one by one, each seeing the previous ones.

The agent may suggest `near`; it never sends coordinates (the input schemas have no `x` or `y`).

**Rooms opened only for writes.** Today a room closes when its last browser leaves. A room opened by an agent with no browser would stay in memory forever, so after each write `rooms.ts` schedules a close in 30 seconds if `room.getNumActiveSessions() === 0`, cancelled by any new write or connection.

**Event hook.** Each tool call that changes something calls `recordEvent({boardId, actor: "agent", onBehalfOf, runId, type, payload})`, a no-op until T08 stores and broadcasts it.

## Tasks

- [ ] `client/package.json`: `@modelcontextprotocol/sdk@1.32.1`, `zod@4.6.5`.
- [ ] Extract `client/server/rooms.ts` from `server.ts` (no behaviour change; `POST /api/rooms/:room/shapes` keeps working).
- [ ] `client/server/layout.ts` with unit tests.
- [ ] `client/server/canvasTools.ts`: the eight core tools as plain functions (`add_highlight` only with T10's PDF reading).
- [ ] `client/server/papersClient.ts`: MCP client to `PAPERS_MCP_URL`, `get_paper` cached per paper ID in memory.
- [ ] `client/server/canvasMcp.ts` and the route in `server.ts`.
- [ ] Idle close in `rooms.ts`.
- [ ] Root `README.md`: replace "Write to a board from another service" with the canvas MCP (keep the REST route as the low-level option).
- [ ] `.env.example`: `CANVAS_MCP_URL` comment now points at `http://localhost:5858/api/mcp/canvas/<boardId>`.

## Acceptance criteria

1. `npx @modelcontextprotocol/inspector` connected to `http://localhost:5858/api/mcp/canvas/demo` with `Authorization: Bearer m_test` lists the eight core tools; `add_papers` with three papers and `near` puts three non-overlapping nodes beside the neighbour, live in an open browser.
2. Calling `add_papers` again with the same IDs and new metadata updates the cards; after a person moves one card, a further call reports it in `skipped` and leaves it where the person put it. A retracted paper is skipped.
3. `set_scores` for two goals colours the node by the viewer's current goal; `set_card` with only `oneLine`, then later `facets`, fills the open card section by section (T10).
4. `add_quote` with text that isn't in the abstract returns a tool error and writes nothing; with a verbatim sentence it adds a quote to the card whose `url` carries the text fragment.
5. After a person deletes a `similar` link, `link_papers` with the same pair reports it in `skipped`; `add_note` with a `paperId` creates a note that moves with that card.
6. Every shape written carries `createdBy`, `onBehalfOf` and, when `X-Run-Id` was sent, `runId`.
7. A write to a board nobody has open succeeds, and the room is closed 30 seconds later.
8. The harness's `toolsets.canvas()` (with `CANVAS_MCP_URL` and `BOARD_TOKEN`) lists the same tools.

## Tests

- `client/server/layout.test.ts`: no overlaps across 200 placements; determinism; `near` respected.
- `client/server/canvasTools.test.ts`: each tool against a real `TLSocketRoom` on a temp `DATA_DIR`, including human-touched skips and idempotency.
- `client/server/canvasMcp.test.ts`: the HTTP route with the SDK's `Client` and `StreamableHTTPClientTransport`; 401 without a bearer.

## Risks

- **Approximate server-side boxes** (no geometry engine on the server): margins absorb small errors; if text-heavy shapes overlap, the layout reads `w`/`h` from more shape types.
- **Quote checks depend on the papers MCP being up:** if `get_paper` fails, `add_quote` returns a tool error saying so rather than writing an unverified quote.

## References

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [building an MCP server](https://modelcontextprotocol.io/docs/develop/build-server)
- [tldraw `TLSocketRoom`](https://tldraw.dev/reference/sync-core/TLSocketRoom)
- [Concept: APIs and data model](../../Concept.md#apis-and-data-model)
