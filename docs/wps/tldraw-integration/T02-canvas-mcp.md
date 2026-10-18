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

**Out (phase 2, once the discovery tools exist):** `add_figure`, `apply_clusters`, `label_cluster`, `add_table`, `add_diagram`, the d3-force "Structure by" layout ([Concept: Clustering and layout](../../Concept.md#system-architecture)).

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
| URL `:boardId` | The room; created on first write like any room today |

**Tools (v1).**

| Tool | Input | Output | Rules |
| --- | --- | --- | --- |
| `get_board` | none | `{boardId, question, papers: [{paperId, title, year, kind, status, rating, fit, working, cluster, humanTouched}], links: [{from, to, relation}], notes: [{shapeId, text, author}], highlights: [{shapeId, paperId, text, category, note, author}], discardedIds}` | Compact, never raw records; `question` and `discardedIds` come from T08's board DB and are empty before it exists; capped at 500 papers |
| `add_papers` | `{papers: [{paperId, title, authors?, year?, venue?, url?, kind?, near?, rating?, fit?, reason?}]}`, at most 50 | `{added, updated, skipped: [{paperId, reason}]}` | ID from `paperShapeId`; an existing card is updated in place unless human-touched (`skipped`, reason `edited by a person`); `status` starts `new`, `working` starts true |
| `link_papers` | `{links: [{from, to, relation}]}`, relation one of `cites`, `cited_by`, `similar`, `contradicts`, `extends` | `{linked, skipped}` | Arrow with two bindings, ID `shape:agent-link-<from>--<to>` so repeats are no-ops; both cards must exist; resizes cards by link count (`w = h = 160 + 16 × min(links, 8)`) unless human-touched |
| `set_rating` | `{paperId, score, fit?, reason?}` | `{ok, skipped}` | `score` 0 to 1 |
| `mark_working` | `{paperIds, on}` | `{ok}` | The "working" badge |
| `set_summary` | `{paperId, tldr?, summary?, whyItMatters?}` | `{ok, skipped}` | Skips if `editedByHuman` |
| `add_note` | `{text, near?}` | `{shapeId}` | Built-in note; `near` is a paper ID |
| `add_highlight` | `{paperId, text, page?, category?, note?}` | `{shapeId}` | `highlight` shape beside its card, linked by an arrow; no `rects` (the overlay anchors it by text, T10) |
| `add_quote` | `{paperId, text, section?}` | `{shapeId}` or an MCP tool error | Rejected unless `text` appears verbatim (whitespace-normalised) in the paper's abstract, or full text once `get_fulltext` exists; the stored `url` gets a `#:~:text=` fragment |

Every write sets the meta from the [shared contracts](README.md#shared-contracts). Tool descriptions are self-contained (an external agent reads only them) and name their limits.

**Human-touched rules, enforced here.** Never change `x`, `y` or `parentId` of a shape with `pinnedByHuman`; never change props of a shape with `editedByHuman`; never touch a shape without `meta.createdBy === "agent"` except to bind an arrow to it; never delete.

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
- [ ] `client/server/canvasTools.ts`: the nine tools as plain functions.
- [ ] `client/server/papersClient.ts`: MCP client to `PAPERS_MCP_URL`, `get_paper` cached per paper ID in memory.
- [ ] `client/server/canvasMcp.ts` and the route in `server.ts`.
- [ ] Idle close in `rooms.ts`.
- [ ] Root `README.md`: replace "Write to a board from another service" with the canvas MCP (keep the REST route as the low-level option).
- [ ] `.env.example`: `CANVAS_MCP_URL` comment now points at `http://localhost:5858/api/mcp/canvas/<boardId>`.

## Acceptance criteria

1. `npx @modelcontextprotocol/inspector` connected to `http://localhost:5858/api/mcp/canvas/demo` with `Authorization: Bearer m_test` lists the nine tools; `add_papers` with three papers and `near` puts three non-overlapping cards beside the neighbour, live in an open browser.
2. Calling `add_papers` again with the same IDs and new ratings updates the cards; after a person moves one card, a further call reports it in `skipped` and leaves it where the person put it.
3. `add_quote` with text that isn't in the abstract returns a tool error and writes nothing; with a verbatim sentence it writes a `quote` shape whose `url` carries the text fragment.
4. Every shape written carries `createdBy`, `onBehalfOf` and, when `X-Run-Id` was sent, `runId`.
5. A write to a board nobody has open succeeds, and the room is closed 30 seconds later.
6. The harness's `toolsets.canvas()` (with `CANVAS_MCP_URL` and `BOARD_TOKEN`) lists the same tools.

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
