# Landing pages

For how these pages and the board fit together, start with [`frontend.md`](frontend.md).

Three static pages in `client/public/landing/`. Vite copies `public/` into `dist/`, so the Node server serves them as they are. There's no React code and no build step, and they don't touch the board.

| Page | URL | What it does |
| --- | --- | --- |
| Start | `/landing/index.html` | One box: a question, a topic, papers (PDF upload, or pasted DOIs and PubMed links), or any mix. Creates a board and opens it. |
| Home | `/landing/home.html` | Your boards, each with its count of new papers and "Catch me up". |
| How it works | `/landing/how-it-works.html` | The explanation, the proof example and "Built with". Static. |

Use the full file names: the server sends `/landing/` (a directory) to the React app, which would open a board room called "landing".

## What the backend needs to provide

Every call is in `landing/api.js`, with the request and response shapes in its header comment. The paths follow Concept.md's REST API under `/api/v1`:

1. **Start, on submit:**
   - `POST /boards` with `{title, question, context}` (no title without a question);
   - `POST /boards/{id}/seeds` once per paper, with `{doi}`, `{pmid}` or a multipart `file`;
   - then the browser opens `/{board.id}?start=1`. The board removes `start` from the URL, opens its chat and sends the agent the onboarding prompt through the chat (`onboardingPrompt` in `client/client/pages/Room.tsx`), so the agent runs in that chat's harness. There is no `POST /boards/{id}/runs`: only sample data still calls it.
   - Pressing ↑ makes one board. If a paper can't be added, the page shows why under the box, keeps that paper's chip, and the next ↑ adds what's left to the same board.
2. **Home:** `GET /boards`. The page reads `id`, `title`, `seedCount`, `paperCount` (paper cards on the board), `newCount` (events since the caller last looked; with the bearer only) and `members`. The board posts `POST /boards/{id}/seen` with its `lastSeq` after 10 seconds, so `newCount` goes back to 0.

**PDF seeds** (`client/server/pdfSeed.ts`):

| Step | Rule |
| --- | --- |
| Accept | `multipart/form-data` with one `file` of type `application/pdf`, at most 20 MB; other types get 415, larger files 413 |
| Read | The text of pages 1 and 2, with `pdfjs-dist` (legacy build, loaded on the first PDF) |
| Find | The first DOI, trailing punctuation trimmed, looked up with `resolve_seed({doi})`; else (or if the papers MCP doesn't know it) the PDF's metadata title, or the largest line on page 1 with the lines it wraps onto, looked up with `resolve_seed({title})` |
| Fail | 422 `no_doi`, "Couldn't find a DOI in <file name>. Paste its DOI instead."; a file pdfjs can't read is 422 `bad_pdf` |
| Keep | The PDF is saved under `DATA_DIR/uploads` (served at `/api/uploads/<id>`), and the seed's response carries it as `upload` |

Additions to the contract:
- **`{pmid}` seeds:** researchers paste PubMed links as often as DOIs.
- **An empty `question`:** papers only. The agent drafts the question from the seeds.
- **No seeds:** question only. The board starts from search hits (flow 2).

Login is faked: the name is kept in the browser and sent as `X-Display-Name`. Errors show their `error.message` under the box, and the input is kept so the user can retry.

## Settings

`landing/config.js` holds:
- **`apiBase`:** the REST base path.
- **`boardUrl(id)`:** where a board opens.
- **`tourQuery`:** what's added to a board URL to start "Catch me up" (`?tour=1`). The board needs to read it.
- **`demoBoardUrl`:** the demo-board link on Start. It points at `demo-board.html`, the board design with sample data.
- **`demoVideoUrl`:** the video section stays hidden until it's set.
- **`repoUrl`.**

Add `?mock=1` to any page URL to use sample data instead of the board service. With sample data, every board link (Start's submit, Home's boards and Catch me up) opens `demo-board.html`.

## The front door

`/` is the Start page: `client/client/pages/Root.tsx` sends it to `/landing/index.html` with a full page load. The multiplayer starter's quick room moved to `/new`, which opens a fresh room.
