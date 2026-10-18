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
   - `POST /boards` with `{title, question, context}`;
   - `POST /boards/{id}/seeds` once per paper, with `{doi}`, `{pmid}` or a multipart `file`;
   - `POST /boards/{id}/runs` with `{kind: "onboarding"}`;
   - then the browser opens `/{board.id}`.
2. **Home:** `GET /boards`. The page reads `id`, `title`, `seedCount`, `paperCount`, `newCount` and `members`.

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

Add `?mock=1` to any page URL to use sample data instead of the board service. A yellow bar says so. With sample data, every board link (Start's submit, Home's boards and Catch me up) opens `demo-board.html`.

## Making it the front door

Not done yet; it's the board team's call. `/` still redirects to a random room in `client/client/pages/Root.tsx`. Redirect it to `/landing/index.html` when the endpoints are ready.
