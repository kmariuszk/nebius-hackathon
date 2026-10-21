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
/ ──────────────────────▶ Start
Start ──(create board)──▶ board /{id}?start=1
Home ──(open)───────────▶ board /{id}
Home ──(Catch me up)────▶ board /{id}?tour=1
Board ──(‹ Boards)──────▶ Home
```

`?start=1` makes the board open its chat and send the agent the onboarding prompt; the board then drops it from the URL, so a reload doesn't start the agent again.

Add `?mock=1` to any page to use sample data instead of the board service. With sample data there's no real board to open, so every board link opens the demo board instead, and its **‹ Boards** button goes back to Home with sample data.

To try it: `cd client && pnpm dev`, then open `/landing/index.html?mock=1`. Use the full file name: `/landing/` falls through to the React app.

## What the board service needs to provide

The start pages call three endpoints, all in `landing/api.js` with their request and response shapes. Paths follow Concept.md's REST API under `/api/v1`, and the board service serves all three:

1. `POST /boards` with `{title, question, context}`
2. `POST /boards/{id}/seeds`, once per paper, with `{doi}`, `{pmid}` or a multipart `file` (a PDF, looked up by its DOI or its title)
3. `GET /boards`, for Home: `id`, `title`, `seedCount`, `paperCount`, `newCount`, `members`

There's no `POST /boards/{id}/runs`: the agent starts in the board's chat (`?start=1`), and only sample data still calls it. `docs/landing.md` has the details: the PDF rules, the three additions to the contract (`{pmid}` seeds, an empty question, no seeds), and how `/seen` resets `newCount`.

What the board shows per paper (the quotes and their checks, the "at a glance" steps, figures, clusters, papers people add, and the changes the agent catches up on) is listed in `docs/mockups/README.md`, under "What the UI needs from the backend" and "What it needs from the backend".

## What the React board needs to do

- **A way back:** a "‹ Boards" button at the top left that opens `/landing/home.html`.
- **Start the agent from a link:** done. With `?start=1`, the board opens its chat and sends the onboarding prompt (`client/client/pages/Room.tsx`, through `chatBus`).
- **Mark the board seen:** done. After 10 seconds on the board it posts `/seen`, so Home's "Catch me up" count starts over.
- **Catch me up from a link:** when the URL has `?tour=1`, start Catch me up as the board opens.
- **The design:** follow the demo board.

## Decided

- **The front door:** `/` is the Start page (`client/client/pages/Root.tsx` loads `/landing/index.html`); the quick random room is at `/new`.

## Left for the board team to decide

- **The demo board link:** `demoBoardUrl` in `landing/config.js` points at the static demo board. Point it at a real prepared board when there is one.
