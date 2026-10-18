# nebius-hackathon

Research canvas for the Nebius hackathon.

- `client/`: the canvas app, from tldraw's Multiplayer starter kit ([tldraw-sync-cloudflare](https://github.com/tldraw/tldraw-sync-cloudflare)), with tldraw installed from npm and the Cloudflare Worker ported to a plain Node server so it can run on a Nebius VM.
  - `client/client/`: the React frontend. Each URL path is a room, so everyone on `/<room>` shares one live board with cursors and presence.
  - `client/server/server.ts`: the sync server. It keeps one tldraw `TLSocketRoom` per room and saves each room to its own SQLite file. It also stores uploaded images and videos on disk, fetches bookmark previews for pasted links, and serves the built frontend.
- `harness/`: the agents, on Google ADK with Nemotron models on Nebius Token Factory. One folder per agent; see [harness/README.md](harness/README.md), including how to add an agent.
- `discovery/`: the papers MCP the agents search with (PubMed, OpenAlex, Semantic Scholar, Tavily); see [discovery/README.md](discovery/README.md).
- `board/`: Python scripts that generate SVG for the planning Miro board.

## Run the agents

You need [uv](https://docs.astral.sh/uv/). Copy `.env.example` to `.env` and fill in at least `TF_API_KEY` and `TAVILY_API_KEY`.

```zsh
cd discovery && uv run python -m discovery    # terminal 1: the papers MCP on :8001
cd harness && uv run adk web harness/agents   # terminal 2: ADK's dev UI on http://localhost:8000
```

`cd harness && uv run python -m harness.check` checks the keys, both Nemotron models' tool calling and both MCP servers.

## Run the client

You need Node 22.18+ and pnpm. Run `corepack enable` once to get the pnpm version pinned in `client/package.json`.

```zsh
cd client
pnpm install
pnpm dev
```

`pnpm dev` starts Vite at http://localhost:5173 and the sync server on port 5858. Vite forwards `/api` requests, including the sync websocket, to the server. The app sends you to a random room. Open the same room URL in another tab or on another machine to collaborate. Rooms and uploads are saved under `client/.data/`, so they survive restarts.

To run it the way it's deployed, run `pnpm build` and then `pnpm start`. This serves the app and the API together at http://localhost:5858.

## Run in Docker

```zsh
docker build -t board client
docker run -p 5858:5858 -v board-data:/data board
```

The app is then at http://localhost:5858. Rooms and uploads are saved in the `board-data` volume.

## Write to a board from another service

Send `POST /api/rooms/<room>/shapes` with a JSON array of shapes, and everyone in the room sees them right away. Each shape needs a `type` and its full `props`. The server fills in the id, the page and the stacking order, and replies with `{ "ids": [...] }`. To update a shape in place later, give it your own id, like `shape:paper-2401-12345`. If any shape is invalid, the server writes nothing and replies 400 with the field that failed.

This route has no auth, just like the websocket: anyone who can reach the server can edit any room.

`client/server/addShape.ts` is a working example that adds a sticky note:

```zsh
cd client
node server/addShape.ts <room> "Hello from the server"
```

## Working with tldraw

Build on tldraw's public API rather than its source: custom shapes (`ShapeUtil`), custom tools, UI overrides, the `editor` API and bindings. The [examples page](https://tldraw.dev/examples) is the quickest place to find something to copy. If you really have to change tldraw internals, use `pnpm patch tldraw` instead of forking.

The tldraw SDK is under the [tldraw license](https://github.com/tldraw/tldraw/blob/main/LICENSE.md): it is free on localhost and in development, but anything deployed for the public needs a license key (tldraw offers trial keys). Don't remove or work around the license check or the watermark, and don't call this project "tldraw".

## MCP

`.mcp.json` adds tldraw's hosted MCP server (`https://tldraw-mcp-app.tldraw.workers.dev/mcp`). Its `search` tool looks things up in the tldraw Editor API. Its drawing tools work on tldraw's own canvas, shown inside MCP clients that support MCP apps; they don't reach the app in `client/`.
