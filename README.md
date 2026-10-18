# nebius-hackathon

Research canvas for the Nebius hackathon.

- `client/`: the canvas app, from tldraw's Multiplayer starter kit ([tldraw-sync-cloudflare](https://github.com/tldraw/tldraw-sync-cloudflare)), with tldraw installed from npm.
  - `client/client/`: the React frontend. Each URL path is a room, so everyone on `/<room>` shares one live board with cursors and presence.
  - `client/worker/`: the sync server, a Cloudflare Worker with one Durable Object per room. Room state is saved in the Durable Object's SQLite storage, and images and videos go to an R2 bucket.
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
