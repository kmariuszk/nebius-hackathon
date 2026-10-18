# Research Canvas

A multiplayer canvas where researchers and AI agents find, rank, and discuss papers together in real time. Drop in a seed paper or a question, and the agent populates the board with scored, clustered results — live, alongside your team — while you keep exploring, voting, and chatting over the same shared board. Built on tldraw for the canvas and Nemotron models (via Nebius Token Factory) for the agents.

**Try it:** run the client below, open a board, click **Chat**, and ask the agent to find papers on a topic.

## Architecture

- `client/`: the canvas app, from tldraw's Multiplayer starter kit ([tldraw-sync-cloudflare](https://github.com/tldraw/tldraw-sync-cloudflare)), with tldraw installed from npm and the Cloudflare Worker ported to a plain Node server so it can run on a Nebius VM.
  - `client/client/`: the React frontend. Each URL path is a room, so everyone on `/<room>` shares one live board with cursors and presence.
  - `client/server/server.ts`: the sync server. It keeps one tldraw `TLSocketRoom` per room and saves each room to its own SQLite file. It also stores uploaded images and videos on disk, fetches bookmark previews for pasted links, and serves the built frontend.
- `harness/`: the agents, on Google ADK with Nemotron models on Nebius Token Factory. One folder per agent; see [harness/README.md](harness/README.md), including how to add an agent.
- `discovery/`: the papers MCP the agents search with (PubMed, OpenAlex, Semantic Scholar, Tavily); see [discovery/README.md](discovery/README.md).
- `board/`: Python scripts that generate SVG for the planning Miro board.

## API keys

The team's API keys live in SecretStash, Nebius AI Cloud's secrets manager, as the secret `app-api-keys` in `group54-project` (`project-e05zbb9fln00tq4scev5wx`, region `uk-south2`). Its keys are named as in `.env.example`: `TF_API_KEY`, `TAVILY_API_KEY`, `OPENALEX_API_KEY`, `NCBI_API_KEY` and `SEMANTIC_SCHOLAR_API_KEY`. A key nobody has filled in yet holds `REPLACE_ME`.

Don't confuse it with `hackathon-object-storage` in the same project: the organizers manage that one, and it holds the Object Storage (S3) credentials.

### Fetch the keys into `.env`

You need the [Nebius CLI](https://docs.nebius.com/cli/install) and `jq`. Sign in once, in the browser, with the account that accepted the hackathon invite:

```zsh
curl -sSL https://artifacts.nebius.cloud/cli/install.sh | bash   # then open a new terminal
nebius profile create hackathon --parent-id project-e05zbb9fln00tq4scev5wx
```

Then, from the repo root:

```zsh
nebius --profile hackathon mysterybox payload get --secret-id mbsec-e05tbcmak0f50xsd0q --format json \
  | jq -r '.data[] | select(.string_value != "REPLACE_ME") | "\(.key)=\(.string_value)"' > .env
```

This overwrites `.env` with the current keys and leaves out the unfilled ones. Every other setting in `.env.example` is commented out at its default; to change one, append it after fetching. SecretStash's CLI service is still called `mysterybox`. If the command says access is denied, ask an organizer to give the team group payload-read on `app-api-keys`, as they did for `hackathon-object-storage`.

### Add or change a key

In the [console](https://console.nebius.com/), open `group54-project`, then **SecretStash**, then `app-api-keys`, and create a new version with every key in it, the changed one included. Make it the primary version; the fetch command reads the primary. Name a new key after the environment variable that reads it, and add that variable to `.env.example`. Keep keys out of the repo, chat and screenshots.

### Use the keys in a deployment

Nebius workloads (Serverless endpoints and jobs) read the secret directly, so the keys never go into an image. Pass one `--env-secret` per variable; each takes the payload entry with the same name:

```zsh
nebius --profile hackathon ai endpoint create ... \
  --env-secret TF_API_KEY=app-api-keys \
  --env-secret TAVILY_API_KEY=app-api-keys
```

In the console, the same thing is under **Secret environment variables** when you create the endpoint or job.

## Run the agents

You need [uv](https://docs.astral.sh/uv/) and a `.env` with at least `TF_API_KEY` and `TAVILY_API_KEY`: [fetch the keys](#fetch-the-keys-into-env), or copy `.env.example` to `.env` and fill it in.

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

To fill a board with the v5 mockup's real papers, links and notes, run `node server/seedDemo.ts demo` from `client/` while the server runs, then open http://localhost:5173/demo and click a paper to open its widgets. Running it again updates the same shapes.

## Chat with the agent

Open a board and click **Chat** on the right edge. The first time you open it, the board service starts one harness (`python -m harness`) for your chat; the server log shows `[harness <board>/<member> <pid>] started`. Answers stream in with the agent's dimmed thoughts, its plan and one card per tool call, each showing model, time and cost. Enter sends, Shift+Enter adds a new line, and Stop cancels the turn. Papers the agent names are links that move your view, and only yours, to the paper. If the chat closes (harness crash, 10 idle minutes, server restart), a banner offers Reconnect, which starts a fresh conversation.

The chat runs the `master` agent on Nemotron 3.5 Super VL, so it needs `TF_API_KEY` in `.env` and the papers MCP running (`cd discovery && uv run python -m discovery`; the server passes `PAPERS_MCP_URL` on to the harness, default `http://127.0.0.1:8001/mcp`). Ask it for papers, for example "Find papers on T cell exhaustion in melanoma immunotherapy resistance. Seed paper: pmid:34290406": it puts the seed and the best-scored papers on the board within about a minute, each with an "Agent is reading…" badge, ranks them, and answers while their cards fill in over the next few minutes. Keep the chat open until the badges clear, since the reading runs in the chat's harness. `HARNESS_AGENT=board_assistant` runs the smaller wiring agent instead, and `HARNESS_AGENT=echo` runs without a model or keys. `HARNESS_CMD`, `HARNESS_IDLE_MINUTES` and `MAX_HARNESSES` are in `.env.example`; [harness/README.md](harness/README.md) covers the adapter, the master's flow on the board and the tests.

## Run in Docker

```zsh
docker build -t board client
docker run -p 5858:5858 -v board-data:/data board
```

The app is then at http://localhost:5858. Rooms and uploads are saved in the `board-data` volume.

## Board REST and SSE API

Everything about a board that isn't a shape (its question, goals, members, votes, removed links, runs and the activity feed) is in one SQLite file, `client/.data/board.db`. A board's row is made the first time its room is used. The routes are under `/api/v1/boards`; writes need `Authorization: Bearer <memberId>`, errors are `{"error": {"code", "message"}}`, and times are ISO 8601 UTC. Set `PAPERS_MCP_URL` for paper records and seeds.

| Method | Path | Request → response |
| --- | --- | --- |
| POST | `/boards` | `{title?, question?, context?}` → 201 `Board` (`b_` plus 10 characters, also the room ID) |
| GET | `/boards` | → `[Board]` the caller made or joined |
| GET | `/boards/:id` | → `Board`: fields, `goals [{id, label}]`, `members`, `seedCount`, `lastSeq`, `agentActive`, and with a bearer `unvoted` and `newSinceLastSeen` |
| PATCH | `/boards/:id` | `{title?, question?, context?, goals?}` → `Board` |
| PUT | `/boards/:id/members/me` | `{displayName?}` → `Member {memberId, displayName, lastSeenSeq, joinedAt}` |
| POST | `/boards/:id/seen` | `{seq}` → 204 |
| POST | `/boards/:id/seeds` | `{doi}` or `{pmid}` → 201 `Paper`, a seed card authored by the caller |
| GET | `/boards/:id/papers` | `?sort=rank\|added&status=new,kept&kind=…&goal=…` → `[PaperRow]` |
| GET | `/boards/:id/papers/:paperId` | → `Paper`: the papers MCP's record, the card's fields, and `board {kind, status, votes {keep, discard}, addedBy, …}` |
| PUT | `/boards/:id/papers/:paperId/vote` | `{decision: "keep" \| "discard" \| null}` → `{status, keepBy, discardBy}` |
| GET | `/boards/:id/papers/:paperId/pdf` | → `application/pdf`, the open-access copy (https and public hosts only) |
| PUT | `/boards/:id/removed-links` | `{from, to, kind}` → 204 |
| GET | `/boards/:id/activity` | `?after=<seq>&limit=` → `[Event]`, newest first |
| GET | `/boards/:id/events` | SSE (`Last-Event-ID` or `?after=` replays what was missed) |

A vote changes the card for everyone: any Keep makes it kept, only Discards discarded, both contested. Discarded papers and removed links reach agents through `get_board`'s `discardedIds` and `removedLinks`.

```zsh
curl -X PUT localhost:5858/api/v1/boards/demo/papers/pmid%3A34290406/vote \
  -H 'Authorization: Bearer m_ana0000000' -H 'content-type: application/json' -d '{"decision":"keep"}'
curl -N localhost:5858/api/v1/boards/demo/events
```

## Write to a board from another service

Agents and other services change a board through the canvas MCP at `http://localhost:5858/api/mcp/canvas/<boardId>` (streamable HTTP, stateless). Send `Authorization: Bearer <memberId>` (an `m_…` ID) and optionally `X-Run-Id: run_<12 hex>` and `X-Model: <model>`. The tools are `get_board`, `add_papers`, `set_scores`, `set_card`, `add_quote`, `link_papers`, `mark_working` and `add_note`. Agents never give coordinates (each new paper is placed beside its neighbour, inside its neighbour's cluster if it has one), nothing is deleted, and shapes people moved or edited come back in `skipped`.

`apply_clusters` and `label_cluster` are listed only while the papers MCP at `PAPERS_MCP_URL` lists `cluster_papers`; the board service checks its tool list at most every 30 seconds. `apply_clusters` asks `cluster_papers` for the board's clusters and draws each one as a frame holding its papers. Papers people added or moved stay where they are. `label_cluster` renames a cluster unless a person already has.

The low-level option is the REST route below.

Send `POST /api/rooms/<room>/shapes` with a JSON array of shapes, and everyone in the room sees them right away. Each shape needs a `type` and its full `props`. The server fills in the id, the page and the stacking order, and replies with `{ "ids": [...] }`. Give a shape your own id, like `shape:paper-2401-12345`, if you want to change it later; posting an id that already exists is refused with 409, so a create never wipes a shape someone has moved or edited. Items with `"typeName": "binding"` (full binding records) are created in the same transaction, after the shapes.

To change shapes, send `PATCH /api/rooms/<room>/shapes` with a JSON array of patches, each with the shape's `id` and only the fields to change. `props` and `meta` are merged key by key, and position, rotation, page and stacking order stay as they were unless the patch sets them. An unknown id gets 404.

If any shape or patch is invalid, the server writes nothing and replies 400 with the field that failed.

This route has no auth, just like the websocket: anyone who can reach the server can edit any room.

`client/server/addShape.ts` is a working example that adds a sticky note:

```zsh
cd client
node server/addShape.ts <room> "Hello from the server"
node server/addShape.ts <room> --paper pmid:34290406 "Some title"
```

## Working with tldraw

Build on tldraw's public API rather than its source: custom shapes (`ShapeUtil`), custom tools, UI overrides, the `editor` API and bindings. The [examples page](https://tldraw.dev/examples) is the quickest place to find something to copy. If you really have to change tldraw internals, use `pnpm patch tldraw` instead of forking.

The tldraw SDK is under the [tldraw license](https://github.com/tldraw/tldraw/blob/main/LICENSE.md): it is free on localhost and in development, but anything deployed for the public needs a license key (tldraw offers trial keys). Don't remove or work around the license check or the watermark, and don't call this project "tldraw".

## MCP

`.mcp.json` adds tldraw's hosted MCP server (`https://tldraw-mcp-app.tldraw.workers.dev/mcp`). Its `search` tool looks things up in the tldraw Editor API. Its drawing tools work on tldraw's own canvas, shown inside MCP clients that support MCP apps; they don't reach the app in `client/`.
