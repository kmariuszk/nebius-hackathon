# D02: Scoring without timeouts

| Field | Value |
| --- | --- |
| Lane | Discovery |
| Size | S |
| Priority | P1 |
| Depends on | — |
| Unblocks | [H04](../agent-harness/H04-first-run-in-90-seconds.md) |
| Milestone | W1 Nothing broken |
| Status | Built (Oct 20, `w1/discovery`). Criterion 5 holds: in the Wave 1 gate run on `w1/integration` (Oct 21, Super VL, cold cache, five demo seeds, report `20261021T160203Z`), the master called `score_candidates` once and it succeeded |
| Owner | TBD |

## Goal

`score_candidates` scores a cold pool of a hundred candidates in one call. A slow embedding request is retried, not fatal; when some candidates still can't be embedded, the rest are scored and `skipped` says which and why. Papers found by `search` and `find_candidates` are embedded in the background, so scoring mostly reads stored vectors.

## Context

- Finding F2 (Oct 19): the first `score_candidates` call failed with only "Error executing tool score_candidates". The discovery log shows `httpx.ReadTimeout` from `Embedder._embed`: two batches of 64 texts went to Token Factory at once, one took over 60 s, and the exception escaped the tool. The master retried and the second call worked, about a minute later.
- `Embedder.documents` (`discovery/discovery/embeddings.py`) sends every batch at once with `asyncio.gather`, a 60 s timeout and no retry; `Discovery.score_candidates` (`service.py`) catches nothing around `_paper_vectors`.
- Vectors are stored in LanceDB by paper ID, text and model, so a paper is embedded once; the cost is all on the first call for a pool.

## Scope

**In:** batch size, concurrency, timeout and retries in the embedder; partial scoring with a `skipped` note; a readable error when nothing can be embedded; background warm-up after `search` and `find_candidates`.

**Out:** changing the score formula; a different embedding model.

## Design

**Embedder** (`embeddings.py`):

| Setting | Value |
| --- | --- |
| `BATCH` | 32 texts per request (was 64) |
| Concurrency | an `asyncio.Semaphore(EMBED_CONCURRENCY)`, default 4, shared by every call in the process |
| Timeout | 90 s per request (was 60) |
| Retries | 2, on `httpx.TimeoutException`, HTTP 429 (wait `Retry-After` when given) and 5xx; waits 2 s, then 5 s |

`documents(texts)` returns `list[list[float] | None]`: `None` for a text whose batch failed after the retries, with the reason kept for the caller (a small `EmbedResult(vectors, failures: dict[index, reason])`).

**Scoring** (`service.py`): `_paper_vectors` stores what was embedded and returns the vectors it has plus the failures. `score_candidates` scores every candidate with a vector and adds `"{n} candidates weren't scored: {reason}"` to `skipped`. When the question itself can't be embedded, or no candidate could, it raises `ValueError` with the reason, which the MCP server turns into a tool error with that text (not "Error executing tool").

**Warm-up.** After `search` and `find_candidates` save their papers, `Discovery` schedules `self._warm(papers)`: an `asyncio` task (kept in a set so it isn't garbage collected, at most one in flight per paper ID) that embeds the papers without a stored vector. It uses the same semaphore, so it never takes more than its share; its errors are logged at WARNING and never reach a tool. `score_candidates` doesn't wait for it: whatever the warm-up stored is a cache hit, the rest is embedded as above.

## Tasks

- [x] `embeddings.py`: `BATCH`, the semaphore, timeout, retries, `EmbedResult`.
- [x] `service.py`: partial `_paper_vectors`, `score_candidates`' `skipped` and errors, `_warm` after `search` and `find_candidates`.
- [x] `.env.example` and `discovery/README.md`: `EMBED_CONCURRENCY`, the new behaviour.
- [x] Tests in `discovery/tests/test_scoring.py`.

## Acceptance criteria

1. An embeddings endpoint that times out once and then answers gives a full result in one `score_candidates` call.
2. An endpoint that always fails for one batch gives scores for the others and a `skipped` entry naming how many weren't scored and why.
3. An endpoint that always fails gives a tool error whose text contains the reason (for example "embeddings timed out after 3 tries").
4. After a `search`, a following `score_candidates` on its papers sends no embedding request for them (the warm-up stored them).
5. In [H01](../agent-harness/H01-live-board-check.md)'s cold run, the master calls `score_candidates` once and it succeeds.

## Tests

`discovery/tests/test_scoring.py`, with an `httpx.MockTransport` embeddings endpoint scripted per request (timeout, 429 with `Retry-After: 0`, 500, success), and the retry waits patched to zero: criteria 1 to 4.

## Risks

- **Warm-up and the chat share Token Factory's limits:** embeddings are a separate endpoint from chat completions, and the semaphore caps them at four requests at once.
- **Retries make a failing call slower:** at most two extra tries per batch, about 3 minutes in the worst case, still under the harness's 10-minute tool timeout; the partial result means it never has to be repeated.

## References

- [discovery README: how ranking works today](../../../discovery/README.md)
- [Token Factory rate limits](https://docs.tokenfactory.nebius.com/ai-models-inference/rate-limits)
