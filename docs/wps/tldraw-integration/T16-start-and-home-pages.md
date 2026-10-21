# T16: Start and Home pages on the real board

| Field | Value |
| --- | --- |
| Lane | Browser + Board |
| Size | M |
| Priority | P0 |
| Depends on | The [T05 refresh](T05-chat-panel.md) (`chatBus`) |
| Unblocks | Demo steps 1–3 on a real board instead of `?mock=1`; [H01](../agent-harness/H01-live-board-check.md)'s onboarding prompt |
| Milestone | W1 Nothing broken |
| Status | Built on branch `w1/chat-start` (Oct 20): Start without `/runs` (`?start=1` and the onboarding prompt through `chatBus`), PDF seeds (`pdfjs-dist` 6.4.299), Home's `paperCount` and `newCount`, `/seen` after 10 s, `/` to Start and `/new`. Left: criteria 1, 3 and 4 by hand in a browser, and how many of the five demo seeds' PMC PDFs resolve |
| Owner | TBD |

## Goal

A researcher types a question and drops five DOIs or PDFs on the Start page, presses ↑, and lands on their new board with the chat open and the agent already working on it. Home lists their boards with how many papers each holds and how many are new, and `/` is the Start page.

## Context

- Finding F11 (reproduced Oct 19): without `?mock=1`, the Start page creates the board and its seeds, then calls `POST /api/v1/boards/:id/runs`, which the board service doesn't serve (404 "No route …/runs"); the page shows the error and stays put, and pressing ↑ again creates a second board. `client/public/landing/landing.js`, `api.js`; `client/server/api.ts`'s route table.
- Finding F12: a PDF dropped on Start is sent as multipart `file`; `postSeed` only accepts JSON `{doi}` or `{pmid}`.
- Finding F13: Home (`landing/home.html`) reads `paperCount` and `newCount`, which `boardView` doesn't return, so it shows no counts and never offers "Catch me up"; the browser never calls `POST /boards/:id/seen` (T08's status), so "new since your last visit" never resets; `/` redirects to a random `test-room-…` (`client/client/pages/Root.tsx`), not to Start ([frontend.md](../../frontend.md), "Left for the board team to decide").
- `harness/acp/mapping.py` and the master need nothing new: the onboarding prompt is an ordinary chat message.

## Scope

**In:** the Start flow without `/runs`; the board opening its chat and sending the onboarding prompt; PDF seeds; Home's counts; `/seen`; `/` to Start; the landing docs.

**Out:** a server-side "run" that works with no browser open (the agent runs in the chat's harness, as everywhere else); the `?tour=1` link (the [T06 refresh](T06-viewer-actions.md)); real accounts.

## Design

**Start** (`landing.js`): in real mode, after the board and seeds, go to `C.boardUrl(board.id) + "?start=1"`; `API.startRun` is called only with sample data. The board-creation hint becomes "Opening your board…".

**The board starts the agent** (`client/client/pages/Room.tsx`): on load, if the URL has `start`, remove it (`history.replaceState`), read the board (`boardApi(roomId, memberId).get()`, a new `GET /boards/:id` helper in `client/client/api.ts`), and call `chatBus.ask({ text: onboardingPrompt(board.question || board.title) })`. The chat bus (T05 refresh) opens the panel, waits until the connection is ready and sends once. The prompt:

> Start this board. The research question is: "<question>". The seed papers are already on the board. Find related papers, put the best ones on the board near the seeds, and tell me what you found.

With no question (papers only, [landing.md](../../landing.md)'s contract): "Start this board. The seed papers are already on the board. Work out the research question from them, then find related papers…". [H01](../agent-harness/H01-live-board-check.md) sends the same text.

**PDF seeds** (`client/server/api.ts`, `postSeed`; new `client/server/pdfSeed.ts`):

| Step | Rule |
| --- | --- |
| Accept | `multipart/form-data` with one `file`, `application/pdf`, at most 20 MB; other types get 415, larger ones 413 |
| Read | Text of pages 1 and 2 with `pdfjs-dist` 6.4.299 (the version already chosen in decision D13; legacy build for Node) |
| Find | The first DOI match (`10.\d{4,9}/[^\s"<>]+`, trailing punctuation trimmed) → `resolve_seed({doi})`; else the PDF's metadata title (or the largest-font line on page 1) → `resolve_seed({title})` |
| Fail | 422 `{error: {code: "no_doi", message: "Couldn't find a DOI in <file name>. Paste its DOI instead."}}`; the Start page shows it under the box and keeps the other papers |
| Keep | The PDF is saved under `DATA_DIR/uploads` like other uploads, so the card can link it later |

`papersClient.resolveSeed` gains a `{title}` variant (the papers MCP's `resolve_seed` already takes `title`).

**Home's counts** (`api.ts`, `boardView`): add `paperCount` (cards on the board, from `syncPapers`) and, with a bearer, `newCount` (the caller's `newSinceLastSeen`).

**Seen** (`Room.tsx`, `client/client/api.ts`): `boardApi.seen(seq)` posts `/boards/:id/seen` with the board's `lastSeq` after the researcher has been on the board for 10 seconds, and again when a Catch me up tour ends (T06 refresh).

**`/` is Start** (`Root.tsx`): `window.location.replace('/landing/index.html')` (a full page load, since the landing pages aren't React); the random room moves to `/new`, so the multiplayer starter's quick room still exists.

## Tasks

- [x] `client/public/landing/landing.js`: no `startRun` in real mode; `?start=1`.
- [x] `client/client/api.ts`: `get()`, `seen(seq)`.
- [x] `client/client/pages/Room.tsx`: `start` handling through `chatBus`; `seen` after 10 s.
- [x] `client/server/pdfSeed.ts`, `postSeed` multipart; `client/server/papersClient.ts` title seeds; `pdfjs-dist` added with `pnpm add pdfjs-dist@6.4.299`.
- [x] `client/server/api.ts`: `paperCount`, `newCount`.
- [x] `client/client/pages/Root.tsx`: `/` to Start, `/new` for a random room; `client/client/main.tsx` route.
- [x] `docs/landing.md`, `docs/frontend.md`: the real flow, `?start=1`, PDF rules, the front door decided.
- [x] Tests (below).

## Acceptance criteria

1. With the board service and the papers MCP running, pressing ↑ on `/landing/index.html` (no `?mock`) with the demo question and the five demo DOIs opens the new board; the chat opens and the onboarding prompt is sent within 5 seconds of the chat being ready; no second board is created.
2. A publisher PDF with a DOI on its first page becomes a seed card; a PDF without one shows "Couldn't find a DOI in <name>. Paste its DOI instead." and the other papers still become seeds.
3. Home lists the board with its seed and paper counts; after the agent adds papers and the researcher is away, it shows "Catch me up N"; after 10 seconds on the board, N goes back to 0.
4. `/` lands on the Start page; `/new` opens a fresh room.
5. With `?mock=1`, Start still opens the demo board as before.

## Tests

- `client/server/api.test.ts`: multipart seeds (DOI found, title fallback with a stubbed papers client, no DOI → 422, wrong type → 415); `paperCount` and `newCount` in `GET /boards/:id` and `GET /boards`.
- `client/server/pdfSeed.test.ts`: two small PDFs built in the test (one with a DOI line, one without) through the same text extraction.
- Manual: criteria 1, 3 and 4 in a browser; record how many of the five demo seeds' PMC PDFs resolve (they are author manuscripts and may carry no DOI).

## Risks

- **Author manuscripts often have no DOI on page 1:** the title fallback covers some; the 422 message tells the researcher what to do, and pasting DOIs stays the demo path.
- **`pdfjs-dist` in Node is heavy:** loaded lazily on the first PDF seed only, so the server starts as fast as today.
- **The onboarding prompt runs before the seeds have synced to the browser:** the agent reads the board with `get_board` on the server, so it sees the seeds whatever the browser shows.

## References

- [landing.md](../../landing.md), [frontend.md](../../frontend.md)
- [T05 refresh: chat bus](T05-chat-panel.md)
- [T08: REST + SSE API](T08-rest-sse-api.md)
