# H01: Live board check

| Field | Value |
| --- | --- |
| Lane | Harness + Board |
| Size | M |
| Priority | P0 |
| Depends on | — |
| Unblocks | The acceptance of H02, H03, H04, D01, D02, D03, D04, D05 and T15 |
| Milestone | W1 Nothing broken |
| Status | Not started |
| Owner | TBD |

## Goal

One command runs the real stack (the papers MCP, the board service and `master` on Nemotron) on a fresh board with the five demo seeds, and fails on every bug the Oct 19 review found: overlapping cards, cards left without "Why it matters" and without a gap, placeholder arguments reaching the papers MCP, and sources skipped with HTTP 400. It writes a report with the timings, so the performance WP has a number to beat.

## Context

- The Oct 19 review ran this by hand (a throwaway script driving `fixtures/acp_client.py` and reading the room's SQLite file). Its findings F1, F3, F4, F6 and F8 are what this check catches; see the [traceability table](../README.md#traceability-findings-to-work-packages).
- The existing live tests (`harness/tests/live/test_board_assistant_live.py`) use stand-in MCPs and only check tool calling. Nothing live covers the master's pipeline on a real board.
- [T12](../tldraw-integration/T12-integration-demo.md)'s live checklist row "A discovery prompt places the first card within 60 s" moves here, with the relaxed targets in the [group README](README.md#shared-contracts).

## Scope

**In:** a pytest fixture that starts discovery and the board service on free ports with temporary data; one live test that creates a board, adds the demo seeds, runs the master through the real ACP adapter, waits for the background reading, and checks the room; the JSON report; a README section.

**Out:** running the browser (the check reads the room directly); judging the quality of the papers found; CI (it needs keys and takes minutes).

## Design

**Requirements.** `uv`, Node 22.18 or later on `PATH` (or `NODE=/path/to/node`), and `TF_API_KEY`, `TAVILY_API_KEY` (and ideally `OPENALEX_API_KEY`, `NCBI_API_KEY`) in the repo's `.env`. The test skips with a message naming what's missing, like the existing live tests.

**The stack** (`harness/tests/live/board_stack.py`, a session-scoped fixture):

| Process | Command | Environment |
| --- | --- | --- |
| Papers MCP | `uv run --project ../discovery python -m discovery` | `DISCOVERY_PORT=<free>`, `DISCOVERY_DB` and `DISCOVERY_VECTORS` in a temp dir (cold cache); `LIVE_WARM=1` keeps `discovery/data` instead |
| Board service | `node server/server.ts` in `client/` | `PORT=<free>`, `DATA_DIR=<temp>`, `PAPERS_MCP_URL=http://127.0.0.1:<discovery port>/mcp` |

The fixture waits until `GET /api/v1/boards` and the MCP endpoint answer (30 s), and stops both on teardown, printing their last 50 log lines if the test failed.

**The run** (`harness/tests/live/test_master_board_live.py`, marker `live`):

1. `POST /api/v1/boards` with the demo question "Which single-cell methods help study melanoma immune cells?" and a member bearer `m_livecheck0`.
2. `POST /boards/:id/seeds` with each DOI from [`docs/demo.md`](../../demo.md): `10.1126/science.aad0501`, `10.1016/j.cell.2018.10.038`, `10.1038/s41586-021-03704-y`, `10.1038/s41586-022-04682-5`, `10.1158/1078-0432.CCR-21-1694`.
3. Start the harness with `fixtures.acp_client.harness` (`HARNESS_AGENT=master`, `PAPERS_MCP_URL` set, `HARNESS_MODEL` unset), `session/new` with the canvas MCP at `http://127.0.0.1:<port>/api/mcp/canvas/<board>`, and send the onboarding prompt that [T16](../tldraw-integration/T16-start-and-home-pages.md) sends from the Start page (same wording, kept as a constant in the test with a comment pointing at `client/client/pages/Room.tsx`).
4. Wait for the prompt to end (`end_turn`, at most 600 s). Keep the harness open and poll `GET /boards/:id/papers` every 10 s until no paper is `working` (at most 900 s), since the reading runs in the chat's harness.
5. Read the room (`harness/tests/live/room.py`): open `<DATA_DIR>/rooms/<board>*` with `sqlite3`, parse each `documents.state`, and compute each card's drawn box: `CARD_SIZE` (172 × 70, from `client/shared/shapes.ts` once T15 adds it; a constant here until then) centred on the node's `props.w × props.h` box, in page space through its parents.
6. Read the timings from `GET /boards/:id/activity?limit=500`: `tFirstCard` is the first `paper.added` event after the prompt, `tFilled` the last `mark_working` off; `tAnswer` is when `prompt` returned.
7. Collect the tool cards from the recorded session updates (`tool_call` and `tool_call_update`: title, `raw_input`, `raw_output`, `_meta` model and cost).
8. Write the report (format in the [group README](README.md#shared-contracts)) and print a short table.

**Always asserted:**

| Check | Catches |
| --- | --- |
| The turn ends with `end_turn` | A crashed or hung master |
| At least 4 suggestions on the board | A run that found nothing |
| 0 pairs of overlapping drawn cards (seeds included) | F6 |
| Every suggestion has `working` off at the end | Badges left on |
| Every suggestion has a non-empty `oneLine`, or a non-empty `gaps` | F3 |
| No `raw_input` of a papers tool (`search`, `find_candidates`, `score_candidates`, `rerank`, `get_paper`, `resolve_seed`) holds a value in the placeholder list (contract in the group README) | F1 |
| No `skipped` entry in a papers tool result contains "400 Bad Request" | F1 |

**Asserted when the tool exists** (the canvas MCP or papers MCP lists it): at least one `cites` link when `citation_links` is listed (D03); 2 to 6 cluster frames when `apply_clusters` is listed (D04); at least one card with a `figure` when `get_figures` is listed (D05).

**Timing** is asserted only with `LIVE_TIMING=strict` (the targets in the group README); otherwise it is reported and printed.

## Tasks

- [ ] `harness/tests/live/board_stack.py`: the stack fixture, free ports, temp dirs, readiness wait, teardown with logs.
- [ ] `harness/tests/live/room.py`: room reader, drawn boxes, overlap count, links by kind, frames, card fields.
- [ ] `harness/tests/live/test_master_board_live.py`: the run, the assertions, the report.
- [ ] `.gitignore`: `harness/tests/live/reports/`.
- [ ] `harness/README.md`: a "Live board check" section (requirements, command, `LIVE_WARM`, `LIVE_TIMING`, how long it takes, what it costs).

## Acceptance criteria

1. On today's `main` the check fails, naming the overlapping cards (F6) and the placeholder arguments (F1): it catches the bugs it was written for.
2. With every W1 work package merged, `uv run pytest -m live -k master_board` passes on a clean checkout with keys, timing aside.
3. The report file has every field of the contract, and the printed table shows the three timings.
4. Without `TF_API_KEY`, or with Node older than 22.18, the test skips with a message saying what's missing.

## Tests

The check is itself the test. Its helpers (`room.py`'s box and overlap maths) get a small offline unit test with two hand-made records that overlap and two that don't (`harness/tests/test_live_room.py`, runs without keys).

## Risks

- **It takes minutes and costs money:** about 10 minutes and a few dozen model calls today, under 5 minutes after H04. One run at a time; never in CI.
- **Timings vary with Token Factory's load:** that's why timing is strict only on request, and H04 asks for two passing runs in a row.
- **The room file format is tldraw's:** reading `documents.state` as JSON works with tldraw 5.5's SQLite storage; if a tldraw upgrade changes it, switch to `GET` through a debug route instead.

## References

- [`harness/tests/fixtures/acp_client.py`](../../../harness/tests/fixtures/acp_client.py)
- [Group README: shared contracts](README.md#shared-contracts)
- [T12: integration check and demo run](../tldraw-integration/T12-integration-demo.md)
