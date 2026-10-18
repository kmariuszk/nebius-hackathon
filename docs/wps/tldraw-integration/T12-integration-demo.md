# T12: Integration check and demo run

| Field | Value |
| --- | --- |
| Lane | All |
| Size | M |
| Depends on | T02 to T07 (T08 to T11 for their beats); the harness owner's `master` and the discovery pipeline for the full discovery run |
| Unblocks | The demo video |
| Milestone | M5 |
| Status | Not started |
| Owner | TBD |

## Goal

One test proves the whole chain works with no API keys, from a WebSocket in a test client, through the real pipe and a real harness process, to a card in the real room and a focus back. The same test then runs live on Nemotron 3.5 Super VL, and one live run with keys does the demo uncut, with the agent reading the board and a paper figure from pictures.

## Context

- [Concept: Product scope, demo plan](../../Concept.md#product-scope) and [the Tavily challenge's judging](../../Concept.md#overview): one complete run with no cuts, a trace that shows decisions, first cards within a minute and the run done in about 90 seconds.
- The group's acceptance criteria in the [README](README.md#acceptance-criteria-for-the-group).

## Scope

**In:** the keyless end-to-end test; the live checklist; Docker smoke test; measuring one harness's memory; updating Concept's protocol paths; the README's run instructions.

**Out:** the discovery pipeline and the master agent themselves (other owners); recording and editing the video.

## Design

**Keyless end-to-end test** (`client/server/e2e.test.ts`, `node --test`, skipped with a message if `uv` isn't installed):

1. Start the board server in-process on a random port with a temp `DATA_DIR` (T02 makes `server.ts` export a start function).
2. Start a fake papers MCP in the test (Node MCP SDK) with `search`, `find_candidates` and `get_paper` returning two canned papers.
3. Set `HARNESS_CMD=uv run --project ../harness python -m harness`, `HARNESS_AGENT=board_assistant`, `HARNESS_MODEL=scripted:../harness/tests/fixtures/e2e-turns.json`, `PAPERS_MCP_URL` to the fake.
4. Connect with the ACP TypeScript SDK (`createWebSocketStream` with Node's `ws`), `initialize`, `session/new` with the canvas MCP, then prompt with text and one selected-shape resource.
5. Assert, in order: a `plan`; a tool card titled `search: search` (inside the sub-agent); a tool card `board_assistant: add_papers` that completes; message chunks; `_canvas/focus` naming the new paper; `end_turn`.
6. Assert the room now holds `shape:paper-…` with `createdBy: "agent"`, `onBehalfOf`, and a `runId` matching the one the tool card's `_meta` reported.
7. Second prompt: cancel during a scripted slow tool; assert `cancelled` within 2 seconds.
8. Close the socket; assert the harness process is gone within 5 seconds.

The scripted turns live in the harness repo folder, next to the adapter's own tests, so the harness side can run the same script without Node.

**Live end-to-end** (`E2E_LIVE=1 node --test server/e2e.test.ts`, skipped without `TF_API_KEY`): the same steps with `HARNESS_MODEL` unset, so `board_assistant` runs on Super VL. Assertions loosen to behaviour: `add_papers` is called and completes, a card appears in the room with the right meta, a `_canvas/focus` arrives, the turn ends with `end_turn`; then "how is the board organised?" triggers a `_canvas/snapshot` request, which the test client answers with `docs/mockups/shots/canvas.png`, and the answer names one of its clusters.

**Live checklist** (with keys; results go in the PR description):

| Check | Pass when |
| --- | --- |
| Live tests | `uv run pytest -m live` in `harness/` and the live end-to-end above pass on Super VL |
| Discovery run | A discovery prompt places the first card within 60 s and finishes within 90 s; every tool card names its Nemotron model |
| The agent looks | "How is the board organised?" and "what does the figure on page N show?" are answered from snapshots (T07, T10 criterion 6) |
| Two browsers | T06 criteria 1 and 2; T10 criteria 3 and 4; T08 criterion 1 |
| Catch me up | On a board prepared earlier, the tour focuses each new paper in Ana's view only, interleaved with the explanation |
| External agent | T11 criterion 2 |
| Docker | `docker build -f client/Dockerfile .` and `docker run` with keys serve the app and a working chat |
| Memory | Peak memory of one idle and one busy harness recorded; `MAX_HARNESSES` default set from it against the [team limits](../../team-limits.md) |

**Demo beats** (Concept's demo plan, with what each needs):

1. Question and seeds, the board fills itself: T02, T04, T05, the master and discovery.
2. Open a paper, highlight a passage, show its node; mark a figure and ask what it shows: T10, T07.
3. Ask the chat a question, the cards behind the answer light up: T06, T07.
4. Switch to a board prepared earlier, "Catch me up": T06, T08 (`last_seen_seq`), the master's tour.
5. Optional: an external agent (Claude Code or Cursor) adds a note to the same board: T11.

**Documentation.** Root `README.md` gets one "Run everything" section (discovery, board service with the harness, browser) and links to this folder. Concept's protocol paths gain the `/api` prefix (decision D4), and the `.env.example` comments match the final routes.

## Tasks

- [ ] `harness/tests/fixtures/e2e-turns.json` and its use in `harness/tests/test_acp_adapter.py`.
- [ ] `client/server/e2e.test.ts`; `server.ts` exports a start function (shared with T02's tests).
- [ ] Live end-to-end mode (`E2E_LIVE=1`) in `client/server/e2e.test.ts`.
- [ ] Live checklist run on Super VL; results in the PR.
- [ ] Docker smoke test; memory measurement; `MAX_HARNESSES` default.
- [ ] Root `README.md` "Run everything"; Concept's protocol paths; `.env.example` comments.

## Acceptance criteria

1. `node --test` in `client/` runs the end-to-end test green on a machine with `uv` and no API keys; with `TF_API_KEY` and `E2E_LIVE=1` it passes live on Super VL.
2. Every row of the live checklist passes, with timings recorded.
3. A teammate follows the root README on a clean checkout and gets a working board with chat.

## Risks

- **The full discovery run depends on other owners' work:** beats 2, 3 and 5 don't, so the demo can be rehearsed early with `board_assistant` and seeded cards.
- **Flaky timing in the end-to-end test:** generous timeouts (30 s for the first update, since `uv run` may sync on first start), and step 7 uses a scripted tool that sleeps on purpose.

## References

- [Concept: Product scope](../../Concept.md#product-scope)
- [Group README: acceptance criteria](README.md#acceptance-criteria-for-the-group)
