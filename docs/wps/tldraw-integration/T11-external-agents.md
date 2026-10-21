# T11: External agents on the canvas MCP

| Field | Value |
| --- | --- |
| Lane | Board + Browser |
| Size | S |
| Depends on | T02, T08 |
| Unblocks | T12 (the "same board from Claude Code" demo beat) |
| Milestone | M5 |
| Status | Not started; deferred: out of the Oct 20 finish plan (see the [top-level README](../README.md#out-of-scope-for-the-finish-plan)). The canvas MCP already accepts a member bearer, so an external client can connect for a demo |
| Owner | TBD |

## Goal

A researcher connects their own agent (Claude Code, Cursor, or any MCP client that supports HTTP servers with headers) to their board in under a minute, and that agent reads and adds to the board through exactly the same canvas MCP our harness uses, attributed to the researcher.

## Context

- [Architecture diagram 1](../../architecture.html#components): "External agents: Claude, Cursor" with dotted MCP arrows into the canvas MCP (and the papers MCP).
- [Concept: Overview](../../Concept.md#overview), "MCP first, with our own harness"; [MCP: every capability](../../Concept.md#mcp-every-capability): "A researcher creates a personal token in board settings and adds both URLs to Claude, Cursor or another MCP client."

## Scope

**In:** personal tokens scoped to one board; the canvas MCP accepting them; a "Connect an agent" dialog with copy-ready setup; rate limiting; a smoke test with the MCP Inspector and Claude Code.

**Out:** OAuth for MCP clients that support only OAuth; exposing the papers MCP publicly (the discovery owner's call; the dialog shows its URL only if `PUBLIC_PAPERS_MCP_URL` is set).

## Design

**Tokens.** `POST /api/v1/boards/:id/tokens {label}` returns `{token, mcpUrl}` once; the token is `pt_` plus 32 random base62 characters. The board DB stores only its SHA-256 in `tokens (token_hash, board_id, member_id, label, created_at, revoked_at)`. `GET /tokens` lists the caller's tokens (label, created, last used); `DELETE /tokens/:id` revokes.

**Canvas MCP auth** (extends T02): `Authorization: Bearer pt_…` resolves to its member, and only for its own board (any other board gives 403). A plain `memberId` bearer keeps working for our own browser and harness. Writes are limited to 60 tool calls a minute per token (HTTP 429 with `Retry-After`). External calls carry no `X-Run-Id`, so their shapes have `runId: null` and `meta.via = "external"`, and the activity feed shows "Claude Code (Ana's token) added 3 papers".

**Tool descriptions and server instructions** (from T02) must be enough on their own, since an external agent sees nothing else: each tool says what it changes, its limits, and the human-touched rule; the server `instructions` give the board rules in [I4](interfaces.md#i4-how-agents-use-the-canvas).

**"Connect an agent" dialog** (header button): create a token with a label, then show it once with the MCP URL and two snippets:

```sh
claude mcp add --transport http paper-board https://<host>/api/mcp/canvas/<boardId> \
  --header "Authorization: Bearer pt_…"
```

```json
{ "mcpServers": { "paper-board": { "url": "https://<host>/api/mcp/canvas/<boardId>", "headers": { "Authorization": "Bearer pt_…" } } } }
```

(the second goes in Cursor's `mcp.json`). The dialog also lists existing tokens with Revoke.

## Tasks

- [ ] `tokens` table (migration 2 in `client/server/db.ts`) and the three routes.
- [ ] Token resolution and rate limit in `client/server/canvasMcp.ts`; `meta.via` on writes.
- [ ] `client/client/connect/ConnectAgentDialog.tsx`.
- [ ] Root `README.md`: "Use the board from your own agent".

## Acceptance criteria

1. With a token from the dialog, the MCP Inspector lists the canvas tools and `add_note` puts a note on the board, live, attributed to the token's member with `meta.via = "external"`.
2. Claude Code, set up with the dialog's command, answers "what's on my board?" from `get_board` and adds a note when asked.
3. The token is refused on another board (403) and after revocation (401).
4. The 61st call within a minute gets 429.
5. The token is never shown again after the dialog closes, and the database holds only its hash.

## Tests

`client/server/tokens.test.ts`: create, hash-only storage, board scoping, revocation, rate limit, `meta.via`.

## Risks

- **The canvas MCP becomes internet-facing** once deployed: tokens, board scoping and the rate limit are the minimum; the demo `memberId` bearer should be disabled on a public deployment (`ALLOW_MEMBER_BEARER=0`) once our browser and harness use tokens too.

## References

- [Claude Code: MCP](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [Cursor: MCP](https://cursor.com/docs/context/mcp)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
