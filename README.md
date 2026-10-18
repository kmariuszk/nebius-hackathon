# nebius-hackathon

Research canvas for the Nebius hackathon.

- `client/`: the canvas app, from tldraw's Multiplayer starter kit ([tldraw-sync-cloudflare](https://github.com/tldraw/tldraw-sync-cloudflare)), with tldraw installed from npm.
  - `client/client/`: the React frontend. Each URL path is a room, so everyone on `/<room>` shares one live board with cursors and presence.
  - `client/worker/`: the sync server, a Cloudflare Worker with one Durable Object per room. Room state is saved in the Durable Object's SQLite storage, and images and videos go to an R2 bucket.
- `board/`: Python scripts that generate SVG for the planning Miro board.

## Run the client

You need Node 20.19+ (or 22.12+) and pnpm.

```zsh
cd client
pnpm install
pnpm dev
```

`pnpm dev` starts the frontend and the sync server together at http://localhost:5173, which sends you to a random room. Open the same room URL in another tab or on another machine to collaborate. Locally, the Durable Objects and R2 are simulated and saved under `client/.wrangler/`, so you don't need a Cloudflare account.

To deploy, you need a Cloudflare account and an R2 bucket named as in `client/wrangler.toml`. Then run `pnpm build` and `pnpm exec wrangler deploy` from `client/`.

## Working with tldraw

Build on tldraw's public API rather than its source: custom shapes (`ShapeUtil`), custom tools, UI overrides, the `editor` API and bindings. The [examples page](https://tldraw.dev/examples) is the quickest place to find something to copy. If you really have to change tldraw internals, use `pnpm patch tldraw` instead of forking.

The tldraw SDK is under the [tldraw license](https://github.com/tldraw/tldraw/blob/main/LICENSE.md): it is free on localhost and in development, but anything deployed for the public needs a license key (tldraw offers trial keys). Don't remove or work around the license check or the watermark, and don't call this project "tldraw".

## MCP

`.mcp.json` adds tldraw's hosted MCP server (`https://tldraw-mcp-app.tldraw.workers.dev/mcp`). Its `search` tool looks things up in the tldraw Editor API. Its drawing tools work on tldraw's own canvas, shown inside MCP clients that support MCP apps; they don't reach the app in `client/`.
