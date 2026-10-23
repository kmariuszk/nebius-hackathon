# H04: A first run in 90 seconds

| Field | Value |
| --- | --- |
| Lane | Harness |
| Size | M |
| Priority | P1 |
| Depends on | H01 (the measurement), H02, [D01](../discovery/D01-validate-optional-arguments.md), [D02](../discovery/D02-scoring-without-timeouts.md) (the bugs that cost the most time) |
| Unblocks | [D04](../discovery/D04-clusters-from-data.md) (clusters run after ranking), the demo recording |
| Milestone | W2 One clean run |
| Status | Done (Oct 21). Two strict H01 runs in a row passed on `w2/timing` (reports `20261021T185349Z`, `20261021T185847Z`): first card 89.8 / 67.0 s (target 90), answer 104.5 / 78.7 s (120), every card read 299.2 / 286.3 s (300). What got it there, after five earlier runs met all three targets once: `rank_papers` ranks only the placed papers with Super VL's reasoning off (24 to 53 s down to 2 to 3.5 s); `score_candidates` waits for warm-up embeddings in flight; embedding tries time out after 15, 30 then 90 s and a Lightning call after 45 s, and are sent again (Token Factory's tail: identical embedding batches took 2 s to 162 s). `PLACE = 6` wasn't needed. Margins are thin: `score_candidates` still takes 15 to 39 s and every card read sits near 300 s |
| Owner | TBD |

## Goal

On a fresh board with the five demo seeds and a cold discovery cache, the first cards land within 90 seconds of the prompt, the answer arrives within 2 minutes, and every card is filled in within 5 minutes. Every placed paper gets a real fit for every board goal, written by code from a ranking per goal, not guessed by the model.

## Context

- Finding F4 (Oct 19 live run, two seeds): first cards about 2 minutes after the prompt, the answer at 180 s, every card filled in about 9 minutes 45 seconds later.
- Where the time went, from the activity feed and tool cards: the search agents retried because of F1 (fixed by H02 and D01); `score_candidates` timed out once and was retried (F2, fixed by D02); `rerank` read 100 abstracts (about 40 s) and ranked 4 papers that weren't on the board, so the master placed them in a second `add_papers`; the master then wrote 16 `set_scores` calls, one per paper, with the `methods` fit guessed from a ranking for the question; the background read 16 papers three at a time.
- Concept's target is 60 s and 90 s ([Concept: Overview](../../Concept.md#overview)); this plan uses the relaxed targets agreed on Oct 20 ([group README](README.md#shared-contracts)).
- A teammate's branch `worktree-place-two-papers` sets `PLACE = 2` to make the demo faster; this WP settles on 8 (decision DH2).

## Scope

**In:** fewer papers per first run; ranking per goal by code (`rank_papers`); a smaller rerank pool; more background parallelism within Token Factory's limit; retries on 429; no narration between tool calls; measuring with H01.

**Out:** early placement on Lightning verdicts (Concept's step 7); faster sources inside the papers MCP beyond D02; turning off Super VL's reasoning for the master (it is what the chat shows as thoughts).

## Design

**Fewer papers.** `PLACE = 8` in `harness/harness/agents/master/agent.py` (was 12).

**`rank_papers`** (`harness/harness/agents/master/ranking.py`, contract in the [group README](README.md#shared-contracts)). A `BaseToolset` like `ProcessPapers`, exposing one `FunctionTool`, `rank_papers()`, with no arguments:

1. Read from the session state that `candidates.note` keeps: the placed suggestions (`candidates.placed`, kind not `seed`), the latest scored order (`candidates.scored`), the question (`candidates.QUESTION`), the seeds and goals from the last `get_board` (`note` also stores `goals` and the seed IDs from `get_board`, a small addition).
2. Pool: the placed suggestions, without seeds and discarded papers. (First built with the next scored candidates up to 20; the Oct 21 live runs showed that cost 34 to 52 s of Super VL reading for papers `rank_papers` never writes, so the pool is the placed papers only.)
3. One `rerank` per goal, in parallel (`asyncio.gather`), through a `Step` with `board.papers("rerank")`, so the calls carry the turn's headers: `goal` is the question plus the goal's description, `seed_ids` the seeds, `exclude_ids` the discarded papers, `k = len(pool)`.
4. One `set_scores` per placed suggestion through a `Step` with `board.canvas("set_scores")`, every goal at once: score and fit from the rerank (high from 0.7, medium from 0.4, else low), `why` the rerank's reason cut to 200 characters; left out → 0.2, low, "Not in the agent's top picks for this goal".
5. Return `{goals: {<goalId>: [{paperId, title, year, reason}] (placed papers only, best first)}, scored: <n>, skipped: [...]}`.

It never calls `add_papers`: a paper the rerank likes that isn't on the board stays off it this turn.

**The master's instruction** (board version):

- Step 7 "Rank" and step 8 "Fit" become one step: "Rank. Call `rank_papers`. It ranks the papers you placed for every board goal and writes their fit; don't call `rerank` or `set_scores` yourself."
- Step 9 "Answer" uses the first goal's list from `rank_papers`.
- A new rule: "Write text only in your final answer. Don't narrate between tool calls; the plan shows your progress." (F5: the chat showed "The scoring call errored; let me retry it once." and runs of blank lines.)
- `rerank` and `set_scores` leave the master's board tool filters (`board.papers(...)`, `board.canvas(...)`); `rank_papers` joins its tools. Follow-ups ("focus on X") call `rank_papers` again after any new search.
- `candidates.fill`'s `rerank` branch stays for the no-board master (`adk web`).

**Background parallelism** (`background.py`): `PAPERS_AT_ONCE = 4` (was 3), `CALLS_PER_MINUTE = 40` (was 30). Eight papers at about five model calls each is 40 calls: two waves of four, about 2 to 3 minutes.

**Retries on 429** (`harness/harness/models.py`): `LiteLlm(..., num_retries=2)` so a Token Factory 429 is retried with LiteLLM's exponential backoff (up to 10 s) instead of failing a step; LiteLLM doesn't read `Retry-After`.

**Measuring.** H01 with `LIVE_TIMING=strict`, cold cache, five demo seeds, twice in a row; then once with `LIVE_WARM=1` for the record. The numbers go in this WP's Status row and in `harness/README.md`.

## Tasks

- [x] `master/agent.py`: `PLACE = 8`, the new Rank step and narration rule, tool filters, `rank_papers` in the tools.
- [x] `master/ranking.py`: `RankPapers` toolset and `rank_papers`.
- [x] `master/candidates.py`: `note` stores the goals and seed IDs from `get_board`; a `pool_for_rerank(state)` helper.
- [x] `master/background.py`: `PAPERS_AT_ONCE`, `CALLS_PER_MINUTE`.
- [x] `models.py`: `num_retries=2`.
- [x] Tests (below); `harness/README.md`'s master section updated (steps, timings).
- [x] Two strict H01 runs; numbers recorded.
- [ ] One `LIVE_WARM=1` run, for the record.

## Acceptance criteria

1. A scripted master turn on a board with two goals calls `rank_papers` once, makes no `rerank` or `set_scores` calls of its own, and every placed suggestion ends with a score for both goals.
2. Papers left out of a goal's rerank get score 0.2 and fit `low` for that goal only.
3. `rank_papers` never adds a card.
4. [H01](H01-live-board-check.md) with `LIVE_TIMING=strict` passes twice in a row: first card 90 s or less, answer 120 s or less, every badge off 300 s or less.
5. In H01's tool cards, the master writes no text between tool calls except the final answer.

## Tests

- `harness/tests/test_master_board.py`: criteria 1 to 3 with the scripted model, the stand-in papers MCP (a `rerank` that returns a fixed order per goal) and `fake_canvas.py`.
- `harness/tests/test_wiring.py`: the master's tool list has `rank_papers` and not `set_scores`.

## Risks

- **Token Factory's limit:** four papers at a time plus the chat can hit 60 requests a minute; `CALLS_PER_MINUTE` keeps the background at 40 and `num_retries` absorbs the rest. If H01 shows 429s, go back to 3 at a time.
- **Two reranks per turn cost twice the tokens:** about 20 abstracts each instead of 100 once, so it's cheaper than today.
- **Eight papers may look thin on the board:** see the group's open question; `PLACE` is one constant.

## References

- [Group README: rank_papers, timing targets](README.md#shared-contracts)
- [Concept: Discovery and ranking pipeline](../../Concept.md#agent-design)
- [discovery README: how ranking works today](../../../discovery/README.md)
