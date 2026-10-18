# Frontend: what's ready

Every screen a user sees is designed and clickable: the start pages and the board. This page says where each one is, how they link together, and what the board service and the React board need to do to use them.

## The pages

All four are static files in `client/public/landing/`. Vite copies `public/` into `dist/`, so the app serves them as they are: no build step, no React.

| Page | URL | What it is |
| --- | --- | --- |
| Start | `/landing/index.html` | One box: a question, papers (PDFs, DOIs, PubMed links), or both. Creates a board and opens it. |
| Home | `/landing/home.html` | Your boards, each with its new papers and "Catch me up". |
| How it works | `/landing/how-it-works.html` | The explanation and "Built with". Static. |
| Demo board | `/landing/demo-board.html` | The board, in its final design, with real papers and stand-in agent output. |

The demo board is the v6 mockup from `docs/mockups/` (see its README for every state). Treat it as the spec for the React board: what's on the canvas, the opened paper's widgets, editing, filters, the ranked list, chat and Catch me up.

## How they link

```
Start ──(create board)──▶ board /{id}
Home ──(open)───────────▶ board /{id}
Home ──(Catch me up)────▶ board /{id}?tour=1
Board ──(‹ Boards)──────▶ Home
```

Add `?mock=1` to any page to use sample data instead of the board service. With sample data there's no real board to open, so every board link opens the demo board instead, and its **‹ Boards** button goes back to Home with sample data.

To try it: `cd client && pnpm dev`, then open `/landing/index.html?mock=1`. Use the full file name: `/landing/` falls through to the React app.

## What the board service needs to provide

The start pages call four endpoints, all in `landing/api.js` with their request and response shapes. Paths follow Concept.md's REST API under `/api/v1`:

1. `POST /boards` with `{title, question, context}`
2. `POST /boards/{id}/seeds`, once per paper, with `{doi}`, `{pmid}` or a multipart `file`
3. `POST /boards/{id}/runs` with `{kind: "onboarding"}`
4. `GET /boards`, for Home: `id`, `title`, `seedCount`, `paperCount`, `newCount`, `members`

`docs/landing.md` has the details, including the three additions to the contract (`{pmid}` seeds, an empty question, no seeds).

What the board shows per paper (the quotes and their checks, the "at a glance" steps, figures, clusters, papers people add, and the changes the agent catches up on) is listed in `docs/mockups/README.md`, under "What the UI needs from the backend" and "What it needs from the backend".

## What the React board needs to do

- **A way back:** a "‹ Boards" button at the top left that opens `/landing/home.html`.
- **Catch me up from a link:** when the URL has `?tour=1`, start Catch me up as the board opens.
- **The design:** follow the demo board.

## Left for the board team to decide

- **The front door:** `/` still redirects to a random room in `client/client/pages/Root.tsx`. Point it at `/landing/index.html` once the endpoints above exist; until then Start can only show "Can't reach the board service".
- **The demo board link:** `demoBoardUrl` in `landing/config.js` points at the static demo board. Point it at a real prepared board when there is one.
