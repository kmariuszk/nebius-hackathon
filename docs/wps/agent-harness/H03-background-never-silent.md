# H03: Background passes never fail silently

| Field | Value |
| --- | --- |
| Lane | Harness |
| Size | M |
| Priority | P1 |
| Depends on | — |
| Unblocks | [T10 refresh](../tldraw-integration/T10-paper-card.md) (the widgets show these gaps) |
| Milestone | W1 Nothing broken |
| Status | Not started |
| Owner | TBD |

## Goal

Every card the master places ends with "Why it matters to you" and "The paper at a glance" filled in, or with a gap that says which one is missing and why. Nothing the background does fails without a line in the log.

## Context

- Finding F3 (Oct 19): on 3 of 16 cards the context agent wrote nothing. The cards have a summary and quotes from the reader, but no `oneLine`, no claims and no glance; the activity feed shows no `set_card` with those fields and no links from them; `gaps` stayed empty and the badge went off as if the card were done. The board then shows an empty "Why it matters" box and a "Reading the paper…" spinner that never stops (F20, fixed in the T10 refresh).
- `ProcessPapers.read_then_relate` (`harness/harness/agents/master/background.py`) treats the context agent's run as done when it returns, whatever it did. Tool errors inside a background agent go back to the model, not to the log, so the server log doesn't say why.
- Finding F24: the master calls the reader through one shared `AgentTool`. `SearchTool` (`harness/harness/agents/master/candidates.py`) exists because `AgentTool` closes its agent's MCP toolset when a run ends, so two parallel calls on one agent cut each other's session; the reader has the same problem if the researcher asks to "read #2 and #3".

## Scope

**In:** checking what the context agent wrote, one retry, gaps when it still fails, logging every background tool error, a fresh reader per master call, and the decision on the context agent's model.

**Out:** tool cards for background passes in the chat; making the reader or context agent produce better text (prompt work beyond the one line below).

## Design

**A recorder on the context agent.** `ProcessPapers.ask` already sets `before_model_callback` on each background agent. For the context agent it also sets an `after_tool_callback` that appends `{tool, ok, error, written}` to a per-job list: `ok` is false when the result has `isError` or an `error` key, `error` is its text (via `error_text`), and `written` is the `written` list from a successful `set_card`.

**After the context run** (in `read_then_relate`, inside the `slots` semaphore):

| Outcome | Action |
| --- | --- |
| A successful `set_card` wrote `oneLine` and `glance` | Done, as today |
| No successful `set_card` wrote `oneLine` | Retry once with the same request plus: "Your last attempt didn't save. Errors: <up to 3 error texts, or 'you called no tool'>. Call set_card with paperId and oneLine first, then claims and glance in a second call." |
| Still no `oneLine` after the retry | Gap: "The agent couldn't write why this paper matters: <short reason>" (the last error, or "it gave no answer") |
| `oneLine` written but no `glance` (after the retry if one ran) | Gap: "The agent couldn't draw the paper at a glance." |

The gaps go through the existing `finish`, which writes `gaps` with `set_card` and turns the badge off; `finish` keeps writing them when part of the work succeeded (the `gaps != written` comparison is replaced by an explicit "new gaps since the reader's write" list).

**Logging.** Every failed tool call in a background agent or `Step` is logged at WARNING: `background <paperId> <agent> <tool>: <error text>`. The server log (`[harness …]` lines on stderr) then says why a card has a gap.

**Context instruction** (`harness/harness/agents/context/agent.py`): step 3 becomes two calls, `set_card` with `oneLine` and `claims` first, then `set_card` with `glance`, so a glance mistake (a missing quote ID) can't lose the "why".

**A fresh reader per master call.** `SearchTool` becomes a general `FreshAgentTool(build)` in `candidates.py`: an `AgentTool` that builds its agent per call. `SearchTool` keeps its recording on top (it subclasses `FreshAgentTool`); the master's reader becomes `FreshAgentTool(reader_agent)`. `harness/harness/acp/scripted.py`'s `use_script` already handles `SearchTool`; it handles `FreshAgentTool` the same way.

**Decision gate (DH3).** After this WP, run [H01](H01-live-board-check.md) twice. If more than 1 card in 8 still needs the "couldn't write why" gap, change the context agent's model to `models.super_vl()` and record both runs' numbers in this WP's Status row.

## Tasks

- [ ] `background.py`: the recorder, the retry, the gaps, explicit "new gaps" in `finish`, WARNING logs for failed background tool calls.
- [ ] `context/agent.py`: two `set_card` calls in the instruction.
- [ ] `candidates.py`: `FreshAgentTool`; `SearchTool` on top of it.
- [ ] `master/agent.py`: the reader through `FreshAgentTool`.
- [ ] `acp/scripted.py`: scripted models for `FreshAgentTool`.
- [ ] Tests (below); the decision gate run; `harness/README.md` notes the new gaps.

## Acceptance criteria

1. A scripted context agent that answers with text and calls no tool leaves the card with the "couldn't write why" gap and the badge off.
2. A scripted context agent whose first `set_card` fails (a claim not in `oneLine`) and whose retry succeeds leaves `oneLine` on the card and no gap.
3. Two parallel scripted reader calls from the master each get their own MCP session; neither fails.
4. In [H01](H01-live-board-check.md), every suggestion has `oneLine` or a gap, and at most 1 in 8 has the "couldn't write why" gap (or the context agent moved to Super VL, with the numbers recorded).

## Tests

`harness/tests/test_master_board.py`, with the scripted model and `fixtures/fake_canvas.py`: criteria 1 to 3, plus a reader failure still clearing the badge (exists; kept green).

## Risks

- **The retry costs time:** at most one extra context run per failing paper; with 8 papers and a failure rate under 1 in 8, about one extra run per board.
- **Super VL for every context pass** (if the gate trips) is slower: it reads about as fast as the reader (25 to 35 s a paper). H04's timing check decides whether that still fits.

## References

- [Group README: gaps the background writes](README.md#shared-contracts)
- [T10 refresh: empty states](../tldraw-integration/T10-paper-card.md)
