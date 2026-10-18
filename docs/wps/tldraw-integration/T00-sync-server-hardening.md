# T00: Harden the sync server and agent permissions (PR #6 review)

| Field | Value |
| --- | --- |
| Lane | Board (+ repo config) |
| Size | S |
| Depends on | — |
| Unblocks | T02, T03 (both build on the code fixed here) |
| Milestone | Before M1 |
| Status | Done (Oct 18): code, config and tests on PR #6; `pnpm test` in `client/` runs `server/hardening.test.ts` |
| Owner | Igor |

## Goal

Fix the critical issues the code review on [PR #6](https://github.com/kmariuszk/nebius-hackathon/pull/6) found in code that already exists, before anything is built on top of it: one bad request or one broken room must never take the sync server down, a shape "update" must never wipe a person's layout, and agents working in this repo must not be able to run destructive git commands or read `.env` without asking.

## Context

The review (kmariuszk, Oct 18, "critical issues only") lists six points. Four are about existing code and config and are fixed here; the two about the plans themselves (contradictions between WPs) are fixed in the WP files directly (see the group README, "PR #6 review").

| # | Finding | Where | Fixed in |
| --- | --- | --- | --- |
| 1 | A WebSocket upgrade with a URL `new URL` can't parse throws in the `upgrade` handler, uncaught, and the process exits | `client/server/server.ts`, `upgrade` handler | This WP |
| 2 | A room that fails to open (corrupt `rooms/<id>.db`, full disk, failed migration) throws inside `handleUpgrade`'s synchronous callback; browsers reconnect, so the server crash-loops; the DB handle leaks if `TLSocketRoom`'s constructor throws | `getRoom`, called from the upgrade callback | This WP |
| 3 | `Bash(git *)` auto-approves `push --force`, `reset --hard`, `clean -fdx` (which deletes the ignored `.env`) and `git -c alias.x='!sh …'`; `.claude/workflows/cascade-mr.md` tells agents to push to `main` and force-push | `.claude/settings.json`, `.claude/workflows/cascade-mr.md` | This WP |
| 4 | `Bash(cat *)`, `head *`, `tail *` auto-approve reading `.env` and `~/.ssh`, and the project-enabled `claude-mem` plugin records session content | `.claude/settings.json` | This WP |
| 5 | Shared contracts contradict each other (paper `type`, prompt context tags, `_canvas/snapshot` target, I1, I4) | WP files | The WPs |
| 6 | The README says giving a shape your own ID updates it in place, but `putShapes` replaces the whole record: position, rotation and `meta` reset and the shape jumps to the top | Root `README.md`, `putShapes` | This WP and T02 |

The reviewer also offered non-critical findings: SSRF in `/api/unfurl`, REST-only rooms that never close, server errors returned as 400, stuck uploads, GitLab template text in `.claude/`, and ordering conflicts between WPs. Those not already covered elsewhere are listed under Scope.

## Scope

**In:** findings 1, 2, 3, 4 and 6; from the non-critical list, the unfurl SSRF (same fix as T08's PDF proxy), 500 vs 400, and stuck uploads, since they're small and in the same file.

**Out:** REST-only rooms that never close (T02's idle close covers it); GitLab template text in `.claude/` (cleanup, not critical); WP ordering (ask the reviewer for the list, then fix in the README).

## Design

**Upgrade handler (findings 1, 2).** Wrap the whole handler body in `try/catch`:

- A URL that doesn't parse, a missing room ID or a missing `sessionId`: write `HTTP/1.1 400 Bad Request` to the socket and destroy it.
- `getRoom` throws: close the SQLite handle if it was opened, log the room ID and error, and close the WebSocket with code `1011` and a short reason. Mark the room as failed for 30 seconds so reconnecting browsers get the same quick close instead of retrying the open in a loop.
- `getRoom` opens the database, then constructs `TLSocketRoom` in its own `try`, closing the database if construction throws.

**Updates merge, never replace (finding 6).** `putShapes` stays insert-only: if a shape with the given ID exists, it is rejected (or skipped) instead of overwritten. A new `patchShapes(boardId, patches)` merges: it keeps `x`, `y`, `rotation`, `index`, `parentId` and existing `meta` unless the patch names them, merges `props` field by field, validates the result, and writes it in the same transaction. The REST route gets `PATCH /api/rooms/:room/shapes` for this, and the root README's "update in place" sentence is corrected. T02's update tools use `patchShapes`, with the human-touched rules on top.

**HTTP error codes.** Validation errors stay 400; anything else in the shapes route returns 500 with a generic message and logs the error.

**Uploads.** A failed upload already removes its partial file, and the `.type` marker is written last. The stuck case is a leftover file without its marker (a crash between the two writes): the next upload of the same ID now removes it and starts again instead of getting 409 forever.

**Unfurl SSRF.** `/api/unfurl` fetches any URL: apply the same guard as T08's PDF proxy (https or http only, resolve the host and refuse private, loopback and link-local addresses, limited redirects, re-checked each hop).

**Agent permissions (findings 3, 4).** `.claude/settings.json`:

| Rule | Value |
| --- | --- |
| allow | `Bash(git status*)`, `Bash(git diff*)`, `Bash(git log*)`, `Bash(git show*)`, `Bash(git fetch*)`, `Bash(ls *)`, `Bash(tree *)`, `Bash(pwd)`, `Bash(mkdir *)` |
| deny | `Bash(git push --force*)`, `Bash(git push -f*)`, `Bash(git push * --force*)`, `Bash(git push * -f*)`, `Bash(git push *main*)`, `Bash(git reset --hard*)`, `Bash(git clean*)`, `Bash(git -c *)`, `Read(./.env)`, `Read(./.env.local)`, `Read(~/.ssh/**)`, `Bash(rm -rf /)`, `Bash(sudo *)` (`.env.example` stays readable: it has no secrets and agents document variables in it) |
| removed | `Bash(git *)`, `Bash(cat *)`, `Bash(head *)`, `Bash(tail *)` (the Read tool covers viewing files) |

`.claude/workflows/cascade-mr.md`: drop "push to `main`" and the force-push steps, or mark them as needing the person's explicit go. Ask the team whether `claude-mem` should stay enabled at project level.

## Tasks

- [x] `client/server/server.ts`: try/catch in the upgrade handler; failed-room cooldown; `getRoom` cleanup on constructor failure; 500 vs 400; upload abort cleanup.
- [x] `client/server/server.ts` (or `rooms.ts` if T02 has extracted it): `putShapes` insert-only, `patchShapes` merge, `PATCH /api/rooms/:room/shapes`.
- [x] `/api/unfurl`: address guard (shared helper with T08's `pdfProxy.ts`, in `client/server/netGuard.ts`).
- [x] Root `README.md`: correct the "update in place" sentence; document `PATCH`.
- [x] `.claude/settings.json`, `.claude/workflows/cascade-mr.md` as above.
- [x] Tests (below).

## Acceptance criteria

1. `curl` with a raw upgrade request to `GET //[` gets a 400 and the server keeps running; other rooms' clients stay connected.
2. With a room's `.db` replaced by garbage, opening that room closes its socket with 1011, the server keeps running, other rooms work, and the log names the room; no file handle is left open.
3. Writing a shape with an existing ID through `POST` doesn't overwrite it; `PATCH` changes only the named fields, leaving position, rotation, stacking and `meta` as they were.
4. `/api/unfurl?url=http://127.0.0.1:5858/` and `http://169.254.169.254/` are refused.
5. An agent session in this repo is asked before `git push --force`, `git reset --hard`, `git clean` or reading `.env`.

## Tests

`client/server/hardening.test.ts` with `node --test`: a raw TCP upgrade with a bad path; a corrupt room file in a temp `DATA_DIR`; `putShapes` and `patchShapes` semantics; unfurl guard with `localhost` and link-local hosts; a leftover upload without its `.type` marker that can be retried. Checked red (the old server crashes on `GET //[` with `TypeError: Invalid URL`) and green (all five pass on Node 22.23).

## References

- [PR #6 review comment](https://github.com/kmariuszk/nebius-hackathon/pull/6)
- [`ws` `handleUpgrade`](https://github.com/websockets/ws)
- [tldraw `TLSocketRoom`](https://tldraw.dev/reference/sync-core/TLSocketRoom)
