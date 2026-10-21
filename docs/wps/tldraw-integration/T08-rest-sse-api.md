# T08: REST + SSE API and board DB

| Field | Value |
| --- | --- |
| Lane | Board |
| Size | M |
| Depends on | T01 (T02's event hook to record agent activity) |
| Unblocks | T09 (votes, goals), T10, T11, T13 (badge, agent presence), T14 (removed links) |
| Milestone | M4 |
| Status | Built and merged (PR #19, Oct 18): board DB (`client/server/boardDb.ts`, not `db.ts`), `api.ts`, `events.ts`, `triage.ts`, `pdfProxy.ts` and their tests; the browser votes through the route. Not yet (Oct 20 finish plan): `POST /seen` from the browser and Home's `paperCount` and `newCount` ([T16](T16-start-and-home-pages.md)), multipart PDF seeds (T16), people's link deletes sent to `removed-links` ([T14 refresh](T14-board-editing.md)) |
| Owner | TBD |

## Goal

Everything about a board that isn't a shape lives in one SQLite board DB behind a small REST API: the board's question, its members, Keep and Discard votes, the board's "Looking for" goals, paper records for the paper widgets, PDFs, links people removed, and an activity feed that streams over SSE. A vote changes the card for everyone through the sync room.

## Context

- [Architecture diagram 1](../../architecture.html#components): "REST + SSE API, board DB: members, votes, runs, events", with "status updates" into the sync rooms; [diagram 3](../../architecture.html#catchup): votes go over REST and the card updates for everyone; [diagram 4](../../architecture.html#model): votes, runs and events live in the board DB.
- [Concept: REST API](../../Concept.md#rest-api-board-service), [Storage](../../Concept.md#storage), [Collaborative triage](../../Concept.md#collaboration-on-the-board).

## Scope

**In:** board DB and migrations; boards, members, papers, votes, activity, SSE, PDF proxy, seeds by DOI or PMID; status rules; event recording for agent writes (T02) and people's votes; lazy board rows for existing rooms.

**Out:** invites with signed tokens and roles (the board URL is the invite in the demo); PDF seed upload (needs Nemotron Parse in discovery); headless runs (`POST /runs`); BibTeX export; recording people's canvas edits in the feed (they're visible on the board already).

## Design

**Files.**

| File | Contents |
| --- | --- |
| `client/server/db.ts` | `node:sqlite` `DatabaseSync` at `DATA_DIR/board.db`; migrations by `PRAGMA user_version` |
| `client/server/api.ts` | Router for `/api/v1/…`; `zod` validation; JSON errors |
| `client/server/events.ts` | `recordEvent()` (replaces T02's no-op) and the SSE hub |
| `client/server/triage.ts` | Vote rules and the card update |
| `client/server/pdfProxy.ts` | Fetch, check and cache open-access PDFs |

**Tables** (from Concept, trimmed to the demo):

| Table | Columns |
| --- | --- |
| `boards` | `id`, `title`, `question`, `context`, `goals` (JSON list of `{id, label}`, default New findings and Methods to reuse, as in v4's "Looking for"), `created_by`, `created_at` |
| `members` | `board_id`, `member_id`, `display_name`, `last_seen_seq`, `joined_at` |
| `board_papers` | `board_id`, `paper_id`, `kind`, `status`, `scores` (JSON, per goal, mirrored from the card for non-canvas clients), `added_by` (`agent` or a member), `on_behalf_of`, `run_id`, `added_at` |
| `decisions` | `board_id`, `paper_id`, `member_id`, `decision` (`keep` or `discard`), `at` |
| `events` | `seq` (autoincrement), `board_id`, `actor`, `on_behalf_of`, `run_id`, `type`, `payload` (JSON), `at` |
| `removed_links` | `board_id`, `from_paper`, `to_paper`, `kind`, `removed_by`, `at`: links people deleted, so the agent never redraws them (T14) |
| `tokens` | Added by T11 |

**Routes** (base `/api/v1`, conventions from [Concept: APIs](../../Concept.md#apis-and-data-model): bearer `memberId` for writes, JSON errors `{"error": {"code", "message"}}`, ISO 8601 UTC times):

| Method | Path | Purpose | Request → response |
| --- | --- | --- | --- |
| POST | `/boards` | Create a board | `{title, question, context}` → `Board` (ID `b_` plus 10 characters, also the room ID) |
| GET | `/boards` | The caller's boards with counts of papers they haven't voted on | → `[Board]` |
| GET | `/boards/:id` | Board, goals, members, seed count, `newSinceLastSeen` for the caller (the "Catch me up" badge, T13), `agentActive`; creates the row for a room that has none | → `Board` |
| PATCH | `/boards/:id` | Edit title, question, context | partial `Board` → `Board` |
| PUT | `/boards/:id/members/me` | Join or rename | `{displayName}` → `Member` |
| POST | `/boards/:id/seen` | Mark the feed seen up to a sequence number (catch-me-up) | `{seq}` → 204 |
| POST | `/boards/:id/seeds` | Add a seed by DOI or PMID: papers MCP `resolve_seed`, then a `paper-card` with `kind: seed`, authored by the member | `{doi}` or `{pmid}` → `Paper` |
| GET | `/boards/:id/papers` | The ranked list for non-canvas clients | `?sort=rank&status=new` → `[PaperRow]` |
| GET | `/boards/:id/papers/:paperId` | Full record for More in the paper widgets (T10: the original abstract next to the AI summary, when the paper was added): board fields, card fields, and the papers MCP's `get_paper` (cached) | → `Paper` (shape of [Concept: Paper record](../../Concept.md#paper-record), with missing parts left out) |
| PUT | `/boards/:id/papers/:paperId/vote` | Keep, Discard, or clear | `{decision: "keep" \| "discard" \| null}` → `{status, keepBy, discardBy}` |
| GET | `/boards/:id/papers/:paperId/pdf` | The open-access PDF, proxied for CORS | → `application/pdf` |
| PUT | `/boards/:id/removed-links` | Record a link a person deleted (T14) | `{from, to, kind}` → 204 |
| GET | `/boards/:id/activity` | Feed, newest first | `?after=<seq>` → `[Event]` |
| GET | `/boards/:id/events` | SSE stream of new events | `Last-Event-ID` or `?after=` → `text/event-stream` |

**Triage rules** (`triage.ts`, from [Concept: Collaborative triage](../../Concept.md#collaboration-on-the-board)): no votes leaves `new` (or `seed`); any Keep and no Discard gives `kept`; only Discards gives `discarded` (hidden, and a negative signal for later runs through `get_board`'s `discardedIds`); Keep and Discard together give `contested`. Each vote updates `decisions` and `board_papers`, then writes the card's `status`, `keepBy` and `discardBy` (and `kind`, which follows the status: `kept` or `suggestion`; seeds stay seeds) in one room transaction, and records a `paper.voted` event. The agent never votes: the canvas MCP has no vote tool. Until this route exists, T10's `votes.ts` writes the same props through the editor, then switches to the route.

**Events.** Types: `board.created`, `member.joined`, `seed.added`, `paper.added`, `paper.updated`, `paper.linked`, `note.added`, `highlight.added`, `quote.added`, `paper.voted`, `link.removed`, and `agent.active` / `agent.idle` (sent when T03's harness registry gains its first or loses its last harness for the board; the top bar shows the agent in the face pile, T13). Payloads are small (IDs, titles, counts). SSE frames are `id: <seq>`, `event: <type>`, `data: <json>`, with a comment heartbeat every 15 seconds; a reconnect with `Last-Event-ID` replays what it missed from the DB. `get_board` (T02) reads `question` and `discardedIds` from here.

**PDF proxy safety.** The URL comes from paper metadata, so treat it as untrusted: `https` only; resolve the host and refuse private, loopback and link-local addresses (no SSRF into the VM); follow at most 3 redirects, re-checking each; require `%PDF` magic bytes; cap at 50 MB; cache under `DATA_DIR/pdfs/<slug>.pdf`; send `Content-Security-Policy: default-src 'none'` like the uploads route.

## Tasks

- [ ] `client/server/db.ts` with migration 1 (tables above).
- [ ] `client/server/events.ts`; wire T02's `recordEvent`.
- [ ] `client/server/triage.ts` with tests.
- [ ] `client/server/api.ts` routes; mount in `server.ts`.
- [ ] `client/server/pdfProxy.ts` with tests.
- [ ] Browser: `client/client/api.ts`, a typed fetch wrapper adding the bearer; `PUT /members/me` on board open; `POST /seen` when the feed is read.
- [ ] Root `README.md`: the API table.

## Acceptance criteria

1. Ana votes Keep on a card: within a second it shows Kept and her avatar in Ben's browser; Ben votes Discard: both see Contested.
2. Ben's browser, subscribed to `/events`, receives `paper.voted` and `paper.added` (from an agent write) as they happen; after a reconnect with `Last-Event-ID` it receives what it missed, once.
3. `GET /papers/:paperId` returns title, authors, year, venue, abstract and open-access link from the papers MCP, plus status and votes.
4. The PDF route serves an open-access PDF and refuses `http://127.0.0.1/…`, `file:` URLs and a non-PDF response.
5. Opening an old random room creates its board row without losing anything on the canvas.

## Tests

`client/server/api.test.ts`, `triage.test.ts` and `pdfProxy.test.ts` with `node --test`, on a temp `DATA_DIR`; the papers MCP is replaced by a small in-process MCP server; the PDF proxy tests use a local HTTP server and check the private-address refusal by resolving `localhost`.

## Risks

- **SSE through proxies** (Vite in dev, Nebius in production) can buffer: send `X-Accel-Buffering: no` and flush after each frame; the heartbeat keeps idle connections open.
- **Two writers to a card** (votes here, agents in T02) could race: both go through one room transaction per write, and the agent never writes `status`, `keepBy` or `discardBy`.

## References

- [Server-sent events (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- [Node `node:sqlite`](https://nodejs.org/api/sqlite.html)
- [Concept: APIs and data model](../../Concept.md#apis-and-data-model)
