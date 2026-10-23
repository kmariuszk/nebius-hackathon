# Interfaces with the harness and discovery owners

The tldraw integration group owns the board-facing half of `harness/` and nothing of `discovery/`. This page lists what we need from the other owners, what we give them, and which of their files we touch. Each item has an ID so pull requests can point at it. Changing an item needs a thumbs-up from both sides.

## What we add to `harness/`

| Path | Owner | What it is | WP |
| --- | --- | --- | --- |
| `harness/harness/__main__.py` | Us | `python -m harness`: starts the ACP adapter on stdio | T04 |
| `harness/harness/acp/` | Us | `adapter.py` (ACP agent, one worker per session), `mapping.py` (ADK events to ACP updates, ACP prompt blocks to `genai` content), `trace.py` (the tool-card plugin), `images.py` (the plugin that shows snapshots to the model) | T04, T07 |
| `harness/tests/live/` | Us | Live agent tests on Super VL, run with `uv run pytest -m live`; plain `pytest` stays keyless | T04, T07 |
| `harness/harness/board/` | Us | `tools.py` (`BoardTools`), `viewer.py` (focus, highlight, open paper), `ids.py` (shape IDs), `assistant.py` (`board_assistant` agent for wiring tests) | T04, T06 |
| `harness/tests/test_acp_*.py`, `tests/fixtures/` | Us | Adapter tests with the existing `ScriptedLlm` and a fake canvas MCP | T04, T06, T07 |
| `harness/pyproject.toml` | Shared | We add `agent-client-protocol==0.12.1`; nothing else changes | T04 |
| `harness/harness/agents/`, `models.py`, `settings.py`, `toolsets.py`, `check.py` | Harness owner | Untouched by us, except the one-line factory change in I1, done by them or with their review | — |

## I1. Agent factory takes the board's tools

Today `toolsets.canvas()` and `toolsets.papers()` read `CANVAS_MCP_URL`, `PAPERS_MCP_URL` and `BOARD_TOKEN` from the environment. The only agent so far, `search`, uses `toolsets.papers(...)`; no agent uses `toolsets.canvas()` yet. Reading the environment works for `adk web`, but one harness process serves one chat whose canvas URL, member and run arrive over ACP, so agents that touch the board (starting with the future `master`) need the session's values instead. The contract:

```python
# harness/harness/board/tools.py  (ours)
class BoardTools:
    board_id: str
    member_id: str

    def canvas(self, *tool_names: str) -> McpToolset: ...   # canvas MCP from session/new, X-Run-Id per call
    def papers(self, *tool_names: str) -> McpToolset: ...   # papers MCP from PAPERS_MCP_URL, same filter rules as toolsets.papers
    def viewer(self) -> list[BaseTool]: ...                  # focus, highlight, open_paper (T06); look_at_board, look_at_paper (T07)
    def plan(self) -> BaseTool: ...                          # update_plan (I3)

    @classmethod
    def from_env(cls) -> "BoardTools": ...                   # CANVAS_MCP_URL, BOARD_TOKEN: today's behaviour, for adk web

# harness/harness/agents/<name>/agent.py  (harness owner)
def build(board: BoardTools | None = None) -> LlmAgent:
    board = board or BoardTools.from_env()
    return LlmAgent(..., tools=[board.canvas("add_papers", "link_papers"), board.papers("search"), *board.viewer()])

root_agent = build()   # unchanged for adk web
```

- `HARNESS_AGENT=<name>` picks `harness.agents.<name>.agent.build`; `board_assistant` (ours) is the default until `master` exists.
- `toolsets.canvas()` and `toolsets.papers()` stay as they are; `BoardTools.from_env()` calls them, so nothing breaks.
- Agents that take no board tools (like today's `search`) keep `build()` with no argument; the factory only passes `board` if the signature accepts it.

## I2. Every tool call is visible, including inside sub-agents

`AgentTool` runs its agent in a separate runner, so the parent's event stream shows only "master called search", not the searches inside it. The adapter registers one ADK plugin on the harness runner (`harness/harness/acp/trace.py`) that turns `before_tool_callback` and `after_tool_callback` into ACP `tool_call` and `tool_call_update`. In ADK 2.12, `AgentTool(include_plugins=True)` (the default) hands the parent's plugins to the inner runner.

What we need from agents: keep `include_plugins` at its default, and give every agent a `name` that reads well in a tool card ("search: find_candidates").

## I3. Plans go through a tool

The chat panel shows the master's plan as a checklist. Rather than parsing free text, the board tools provide `update_plan(entries: list[{content, status, priority}])`. The adapter turns each call into an ACP `plan` update and hides the call itself from the tool cards. Agents that plan call it at the start of a turn and again as steps finish.

## I4. How agents use the canvas

These rules are enforced by the canvas MCP (T02), but agents that follow them get better results and fewer `skipped` entries:

- Never send coordinates; name a neighbour with `near` (a paper ID or a cluster ID) and the layout service places the card.
- Only add, or update your own shapes. People's shapes and shapes a person has moved or edited come back in `skipped` with a reason.
- Never delete anything, never vote.
- Use `get_board` for the board's state; it is a compact summary, never raw tldraw records.
- Use the viewer tools (`focus`, `highlight`, `open_paper`, `tour`, `look_at_board`, `look_at_paper`) to point at, walk through or look at things for the person you are talking to; they never change the shared board.
- Mention papers in answers as `[Title](paper:<paperId>)` so the chat panel can make them clickable.

What the v5 board ([mockup](../../mockups/README.md)) needs from agents. Most of it goes through T02's canvas MCP tools, which any agent can call; `tour` is a session-bound viewer tool from T06 that only our harness has (external agents can't call it):

| v5 element | Tool | Notes |
| --- | --- | --- |
| Node colour and ranking per "Looking for" goal | `set_scores` | One `{score, fit, why}` per board goal (`goals` in `get_board`); `why` is the ranked list's line |
| "Why it matters to you" | `set_card` (`oneLine`, `claims`) and `add_quote` | `oneLine` is the summary written for the board's question, a sentence or two. Add quotes first, then claims that point at their IDs; each claim's `text` appears verbatim in `oneLine`; a claim citing "three of your seeds" uses evidence `seeds` |
| "The paper at a glance" | `set_card` (`glance`) and `add_quote` | 3–4 steps from the abstract (samples, method, readout, finding), each `{label, text, quoteId, relation}`: `quoteId` names the quote for the sentence it comes from, `relation` is `same`, `adds` or `other` compared with the seeds, or null (usually the finding). Quote IDs must exist on the card, as for claims |
| Figure | `set_card` (`figure`) | A real figure from the paper, never generated: `{imageUrl, label, caption, captionByAi}`, with `captionByAi` true when you wrote the caption |
| Under More | `set_card` (`summary`, `gaps`); `add_papers` (`foundBy`) | Short; `gaps` is what you couldn't check; `foundBy` is how discovery found the paper |
| "Agent is reading…" | `mark_working` | On when reading starts, off when the widgets are filled |
| Links | `link_papers` with `kind: "cites"` (from PubMed) or `"similar"` (your judgement) | Never relabel, unhide or redraw links people changed; skipped ones come back in `skipped` |
| Notes | `add_note` with `paperId` | Pinned to the paper, shown in its Team notes widget |
| Catch me up | `tour` (viewer tool, T06; not on the canvas MCP) | Ordered steps, one line per paper (strongest first), sent once; the browser shows each line in the actions widget under the paper's node |
| "Update suggestions" | — | The prompt carries `<board-changes>`; treat each change as the researcher's decision: re-rank and search around changed papers, and never undo a change |

## I5. What the board service needs from the papers MCP

The board service is an MCP client of the papers MCP for paper details (T08) and quote checks (T02).

| Tool | Status on `main` (Oct 20) | We read | Used by |
| --- | --- | --- | --- |
| `get_paper(paper_id)` | Exists | `paperId`, `ids`, `title`, `authors`, `year`, `venue`, `url`, `abstract`, `openAccessPdf`, `type`, and (wanted, [I9](#i9-discovery-data-the-v5-widgets-show)) `citedBy` and `peerReviewed` (built in the [T09 refresh](T09-ranked-list.md); `peerReviewed` is false for preprints, else null), `retracted` | T08 paper record, T02 `add_quote` check against the abstract, T10 widgets |
| `get_fulltext(paper_id)` | Exists (`sections[{title, text}]`, `source`, `figures[{figureId, label, caption}]`; no page numbers); figures gain `imageUrl` in [D05](../discovery/D05-real-figures.md) | `sections`, `source` | The reader agent; T02 `add_quote` still checks the abstract only |
| `get_figures(paper_id)` | Built (PR #28) ([D05](../discovery/D05-real-figures.md)): `{paperId, source, figures: [{figureId, label, caption, imageUrl}], skipped}` (no `page` or `bbox`; `imageUrl` null when PMC's article page had no image for the figure) | `figures` | The background's figure write via `set_card` (D05), the figure widget (T10), `look_at_figure` (T07 refresh) |
| `cluster_papers(paper_ids)` | Built on branch `w3/clusters` ([D04](../discovery/D04-clusters-from-data.md)): this shape plus `skipped`, 2 to 500 IDs, optional `k`; `clusterId` is `c-` and the medoid paper's slugged ID; `label` null when Lightning couldn't name the cluster | `clusters [{clusterId, paperIds, label}]`, `similarities [{a, b, similarity}]` (k nearest neighbours per paper) | T02 `apply_clusters`, which calls it itself, so clusters come from data rather than from the agent |
| `citation_links(paper_ids)` | Built (PR #28) in [D03](../discovery/D03-citation-links.md) (2 to 200 IDs) | `links [{from, to, source}]` (`from` cites `to`), `skipped` | The harness's citation step, which writes `link_papers` kind `cites` with `source` (D03) |

Until a planned tool exists, the feature that needs it is hidden, not faked: `add_quote` checks only the abstract, the widgets show no figure, and `apply_clusters` and `label_cluster` aren't listed. The canvas MCP reads the papers MCP's tool list on each request, cached for 30 seconds, so the cluster tools appear without a board service restart once discovery serves `cluster_papers`.

## I6. Which model slots take images

T07 sends pictures of the board and of paper pages, and lets agents ask for more. Every board-facing agent runs on Nemotron 3.5 Super VL, which reads them (checked Oct 18). The adapter still needs to know the model of the agent receiving an image, so a sub-agent on Lightning (text-only per Concept; not checked) gets a text note instead of a picture it can't use. Proposal for `harness/models.py` (harness owner): an `accepts_images(model) -> bool` helper, true for Super VL.

What we ask of agents that talk to the researcher (the future `master`): run on `models.super_vl()`, keep `board.viewer()` in their tools (it includes `look_at_board` and `look_at_paper`), and include the board-context paragraph from `harness/harness/board/` in their instruction.

## I7. Environment

| Variable | Owner | Notes |
| --- | --- | --- |
| `TF_API_KEY`, `SUPER_VL_MODEL`, `LIGHTNING_MODEL`, `TAVILY_*` | Harness owner | Unchanged |
| `PAPERS_MCP_URL` | Shared | Read by the harness (exists) and the board service (T08) |
| `CANVAS_MCP_URL`, `BOARD_TOKEN` | Harness owner | Still used by `adk web`; ignored under ACP, where the session provides them |
| `HARNESS_AGENT`, `HARNESS_MODEL`, `BOARD_INTERNAL_URL` | Us | Read only by `harness/harness/acp/` and `board/` |

**Key name.** Token Factory's docs call the key `NEBIUS_API_KEY`; the repo's `.env.example` and `harness/settings.py` use `TF_API_KEY`. Keep both in `.env` with the same value (done on the integration machine, Oct 18).

## I8. Token Factory notes for the harness owner

Found while checking the model on Oct 18 (`uv run python -m harness.check` and small probes through ADK; details in the [group README](README.md#the-model-nemotron-35-super-vl-on-token-factory)):

| Finding | Effect | Suggestion |
| --- | --- | --- |
| **Lightning skipped the tool** in `harness.check`: it answered "The sum is 5555." without calling `add` (Super VL passed) | The `search` agent runs on Lightning and depends on tool calls | Rerun a few times to see if it's flaky; if it keeps failing, try a stricter instruction, `tool_choice`, or Super VL for `search` until it's fixed |
| **Super VL returns reasoning separately** (`reasoning_content`), and ADK turns it into parts with `thought = true` | Code that joins `part.text` over all parts (like `check.py`'s `tool_call`) mixes the reasoning into the answer: the check printed "The result is 5555. The user said … So I should output just 5555.5555" | Skip parts with `part.thought` when reading answers; the ACP adapter (T04) already does |
| **Reasoning can be turned off per call** with `chat_template_kwargs: {"enable_thinking": false}` | Faster, cheaper replies for simple steps | Expose it per slot in `models.py` (for example a `super_vl(thinking=False)` variant passing the extra body through `LiteLlm`), and use it where reasoning adds nothing |
| **Rate limits start at 60 requests and 400,000 tokens a minute** and scale up with sustained use; over the limit gives HTTP 429 with `Retry-After` ([docs](https://docs.tokenfactory.nebius.com/ai-models-inference/rate-limits)) | Bulk scoring (hundreds of Lightning calls) will hit 429 | Concurrency limit and `Retry-After` handling in the discovery service's scoring; Token Factory also offers a Batch API with higher limits |
| **Images are cheap**: about 1,400 prompt tokens for a 275 KB board screenshot | Visual context is affordable | The reader agent can look at page images and figures as well as Parse's text |
| **Lightning writes placeholders for optional arguments** (Oct 19 live run): `since: "None"`, `sources: "None"`, `exclude_ids: "None"` as strings | The papers MCP accepted `since`, and every source returned nothing or HTTP 400; the search agent retried over a dozen times | The harness drops placeholder values from optional MCP arguments ([H02](../agent-harness/H02-clean-tool-arguments.md)) and the papers MCP treats them as unset ([D01](../discovery/D01-validate-optional-arguments.md)) |

## I9. Discovery data the v5 widgets show

v4's "What the UI needs from the backend" lists fields the discovery service supplies and the agent writes to the card; v5 adds `glance[]` and drops `facets` ([mockups README](../../mockups/README.md)). From the board's side:

| Field | Shown in | Source we expect |
| --- | --- | --- |
| `scores` per goal | Node colour, ranked list, the fit line in "Why it matters to you" | `score_candidates` per board goal (Concept), written with `set_scores` |
| `glance[]` | "The paper at a glance" | The agent (reader or context agent) extracts 3–4 steps from the abstract (samples, method, readout, finding), each with a label, a short text, the ID of the quote it comes from, and `same`, `adds` or `other` against the seeds; written with `set_card`. The app draws the diagram, so no image model is involved |
| `citedBy` | Under More ("What supports this"), quality filter | Semantic Scholar counts (v4 used them), on the paper record and in `add_papers`; built on branch `w3/filters` ([T09 refresh](T09-ranked-list.md)): OpenAlex `cited_by_count` and Semantic Scholar `citationCount`, as `citedBy` in paper records and summaries, and in `add_papers` through the harness's `CARD_FIELDS` (null when the paper only came from PubMed) |
| `foundBy` | Under More, how the paper was found | Discovery's own account per candidate (for example `pubmed`, `cites 3 seeds`), in `add_papers` |
| `type`, `peerReviewed` | Preprint or Review flag on the title, ranked list status, type and quality filters | As discovery emits it today (`article`, `review`, `preprint`, or OpenAlex's raw `work.type`); T02 normalises to `article`, `review`, `preprint` or `other` (T01). Preprints mean not peer reviewed; `peerReviewed` is null when unknown |
| `retracted` | Never shown | PubMed marks retractions; `add_papers` skips them |
| `figures[]` with the figure picked per goal | Figure widget, ranked list thumbnail | PMC figures (v4: `efetch db=pmc` captions, images from the article page); written with `set_card`. Built (PR #28) ([D05](../discovery/D05-real-figures.md)): one figure per paper, the reader's first pick by caption that has an image, from `get_figures`; a figure per goal stays later work |
| Model and time per step | Chat steps only | The trace plugin (T04); the widgets carry a plain "AI" tag, and the `X-Model` header (T02) fills each field's `provenance` |

v4's notes from building the mockup also apply: OpenAlex's shared keyless budget runs out at a venue (use a key, or PubMed's `elink` citations); PMC figure pages sometimes return a block page (retry slowly); remove seeds before ranking; show all-capital titles in sentence case (T01 does this on display).
