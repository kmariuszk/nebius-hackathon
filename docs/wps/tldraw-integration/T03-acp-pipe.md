# T03: ACP pipe: WebSocket to harness stdio

| Field | Value |
| --- | --- |
| Lane | Board |
| Size | S |
| Depends on | T00 (the upgrade handler's try/catch), T04 echo mode (or any stdio ACP agent) |
| Unblocks | T05 |
| Milestone | M1 |
| Status | Not started |
| Owner | TBD |

## Goal

A browser opens `/api/acp?board=…&member=…` and is talking ACP to a fresh harness process: each WebSocket text frame becomes one line on the harness's stdin, each line on its stdout becomes one frame. The pipe never parses ACP beyond "is this JSON", and it never leaves a harness running after its socket is gone.

## Context

- [Architecture diagram 1](../../architecture.html#components): "ACP pipe" between the chat panel (WebSocket) and the agent harness (stdio).
- [Concept: Board service: the ACP pipe](../../Concept.md#acp-one-researchers-conversation) has the sketch this WP hardens.
- ACP's standard transport is stdio, newline-delimited, and the agent must write nothing else to stdout ([ACP transports](https://agentclientprotocol.com/protocol/transports)). Decision D1 in the group README.

## Scope

**In:** the upgrade route; spawning and wiring; framing; lifecycle and limits; logging; Docker image that can spawn the Python harness; README.

**Out:** auth beyond the demo `member` parameter (tickets later, see the group README); session resume across reconnects (`loadSession` is off in v0).

## Design

**Route.** `client/server/acpPipe.ts` exports `handleAcpUpgrade(req, socket, head)`. `server.ts`'s `upgrade` handler sends `/api/acp` there and keeps `/api/connect/:board` for sync, inside the try/catch T00 adds: a bad request gets a 400 and a spawn or wiring error closes only that socket, never the process. Query: `board` (required, same `safeId` rule as rooms) and `member` (required, `m_` prefix).

**Spawn.**

| Setting | Value |
| --- | --- |
| Command | `HARNESS_CMD`, default `uv run --project ../harness python -m harness` (run with `shell: false`, split on spaces; quoted values aren't needed) |
| Working directory | `client/` in dev, `/app` in Docker |
| Environment | the server's environment plus `BOARD_ID`, `MEMBER_ID`, `BOARD_INTERNAL_URL=http://127.0.0.1:$PORT`, `PYTHONUNBUFFERED=1` |
| stdio | `['pipe', 'pipe', 'pipe']`; stderr lines go to the server log as `[harness <board>/<member> <pid>] …` |

**Framing.**

- Browser to harness: each text frame is parsed as JSON (rejecting binary frames and anything that isn't an object or array), re-serialised with `JSON.stringify` (so it can't contain a newline) and written with `\n`.
- Harness to browser: `readline` on stdout; each line that parses as JSON is sent as one frame; any other line is logged as a protocol violation and dropped.
- Backpressure: if `ws.bufferedAmount` passes 1 MB, pause stdout until it drains.

**Lifecycle.**

| Event | Action |
| --- | --- |
| Socket closes | End stdin; `SIGTERM` after 2 s if still alive; `SIGKILL` after 5 s |
| Harness exits | Close the socket with code 1000 if exit code 0, else 1011 and a short reason |
| No frames either way for `HARNESS_IDLE_MINUTES` (default 10) | Close the socket (which ends the harness) |
| `MAX_HARNESSES` (default 8) already live | Refuse the upgrade with HTTP 503 |
| Server shuts down (`SIGINT`, `SIGTERM`) | Close every socket, wait up to 5 s for children |
| Spawn fails (`ENOENT`) | Close with 1011, reason "harness not found: set HARNESS_CMD", and log the command |

**Docker.** The board image needs Python and the harness to spawn it:

- Build from the repo root (`docker build -f client/Dockerfile .`) so `harness/` is in the context.
- Add `uv` (copied from the official `ghcr.io/astral-sh/uv` image) and Python 3.12; `uv sync --frozen --project harness --no-dev`.
- `HARNESS_CMD=uv run --project /app/harness --no-sync python -m harness` in the image.
- Keys reach the container as environment variables at `docker run`, never baked into the image.

## Tasks

- [x] The upgrade branch in `client/server/server.ts`: `/api/acp` goes to `handleAcpUpgrade` (on `feat/board-build`).
- [ ] `client/server/acpPipe.ts`: replace the stub, which refuses every chat with a 503.
- [ ] Registry of live harnesses (count, idle timers, shutdown).
- [ ] `client/Dockerfile` and `client/.dockerignore` for a repo-root context; README's "Run in Docker" updated.
- [ ] `.env.example`: `HARNESS_CMD`, `HARNESS_IDLE_MINUTES`, `MAX_HARNESSES` (commented, board service section).
- [ ] Root `README.md`: "Chat with the agent" section.

## Acceptance criteria

1. With `HARNESS_CMD` pointing at T04's echo mode, a WebSocket client that sends `initialize`, `session/new` and `session/prompt` receives the echo agent's `session/update` frames and the prompt result.
2. Closing the socket mid-prompt leaves no `python -m harness` process after 5 seconds.
3. A harness line that isn't JSON is logged and never reaches the browser.
4. The ninth simultaneous chat (with the default limit) gets HTTP 503; the first eight work.
5. `docker run` of the image with `TF_API_KEY` set serves the app and spawns a harness for a chat.

## Tests

`client/server/acpPipe.test.ts` with `node --test`, using a tiny Node script as the "harness" (echoes each stdin line back as a `session/update`, prints one non-JSON line, exits on stdin end): framing both ways, non-JSON drop, kill on close, 503 at the limit, 1011 on a missing command.

## Risks

- **WebSockets on Nebius Serverless** may be cut by an idle proxy: the browser (T05) sends nothing between turns, so the pipe answers ping frames and T05 sends an application-level heartbeat if the deployment shows idle cuts. Check during the first-hour deployment test.
- **Process count on a small VM** ([team limits](../../team-limits.md)): `MAX_HARNESSES` keeps it bounded; measure one harness's memory during T12 and set the default from it.

## References

- [ACP transports](https://agentclientprotocol.com/protocol/transports)
- [Node `child_process.spawn`](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options)
- [`ws` server](https://github.com/websockets/ws)
