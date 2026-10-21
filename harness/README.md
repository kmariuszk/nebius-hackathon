# harness

The agents, built on [Google ADK](https://adk.dev) with Nemotron models on Nebius Token Factory through LiteLLM. Agents reach every capability through MCP: the papers MCP in `discovery/`, the canvas MCP in the board service, and Tavily's remote MCP. See `docs/Concept.md` (Agent design) for the agents we plan.

| Path | What it is |
| --- | --- |
| `harness/settings.py` | Reads the environment and the repo-root `.env` |
| `harness/models.py` | `super_vl()` and `lightning()`, each a `LiteLlm` pointed at Token Factory |
| `harness/toolsets.py` | `papers(...)`, `canvas(...)` and `tavily(...)`: MCP toolsets limited to the tools you name |
| `harness/agents/<name>/agent.py` | One agent per folder: `build()` and `root_agent` |
| `harness/check.py` | Checks the keys, models, tool calling and MCP servers |
| `tests/` | Agents run against a scripted model and a stand-in MCP server, no keys needed |

## Run

You need [uv](https://docs.astral.sh/uv/). Copy `.env.example` to `.env` at the repo root and fill in `TF_API_KEY` (and `TAVILY_API_KEY`).

```zsh
cd discovery && uv run python -m discovery    # terminal 1: the papers MCP on :8001
cd harness && uv run adk web harness/agents   # terminal 2: ADK's dev UI on http://localhost:8000
```

Pick `master` in the dev UI to talk to the full discovery loop (a question, optionally with seed DOIs or PMIDs; a first answer takes about two minutes), `search` to try one sub-query, or `reader` with `Paper ID: pmid:34290406` to see one paper's artifacts. The events panel shows each tool call and result. `uv run adk run harness/agents/master` does the same in the terminal.

```zsh
uv run python -m harness.check   # Token Factory models, tool calling on both models, both MCP servers
uv run pytest                    # offline tests
```

## Add an agent

1. Copy an existing agent: `cp -r harness/agents/search harness/agents/context`. The folder name must be a valid Python identifier.
2. In `agent.py`, set the name, description, model, instruction and tools. Name only the tools the agent needs:

   ```python
   def build() -> LlmAgent:
       return LlmAgent(
           name="context",
           description="Explains why one paper matters for the board's question and links it in.",
           model=models.lightning(),
           instruction=INSTRUCTION,
           tools=[toolsets.canvas("get_board", "set_summary", "link_papers")],
       )

   root_agent = build()
   ```

3. Restart `adk web`; the new folder shows up in the agent list.
4. To call it from another agent, add `AgentTool(agent=context.build())` (from `google.adk.tools.agent_tool`) to that agent's tools, or pass it in `sub_agents`.
5. Add a test next to `tests/test_search_agent.py`: script the model's turns with `call(...)` and `say(...)` and assert on the MCP calls.

## Agents

| Agent | Model | Tools | Status |
| --- | --- | --- | --- |
| `master` | Super VL | `search` and `reader` agents (as tools, each built fresh per call by `candidates.FreshAgentTool`, so parallel calls don't cut each other's MCP session), papers `resolve_seed`, `get_paper`, `rerank`; on a board also papers `score_candidates`, canvas `get_board`, `add_papers`, `set_scores`, `link_papers`, `add_note`, `process_papers`, the viewer tools and `update_plan` | Built; the default chat agent. On a board it runs the discovery onto the board (below). Without one (`adk web`) it runs about three sub-queries in parallel, reranks every candidate they found and answers in the chat. Candidate IDs go from the tool results to the papers MCP without a model retyping them (`agents/master/candidates.py`). Calls `reader` when asked to summarise a paper |
| `search` | Lightning | papers `search`, `find_candidates` | Built; runs one sub-query and answers with its picks as JSON; the IDs its tools return go to the master's candidate pool |
| `reader` | Super VL | papers `get_fulltext`, `check_quotes` | Built; reads one paper and answers with its artifacts as JSON: TL;DR, summary, plain-language abstract, categorised highlights, quotes with highlight links, and key figures by caption. Every highlight and quote is checked word for word against the text. About 25 to 35 s a paper |
| `context` | Lightning | canvas `get_board`, `add_quote`, `set_card`, `link_papers` | Built; relates one read paper to the board: writes "why it matters" (`oneLine` and its claims) and "the paper at a glance" on its card, and links it to the closest papers with kind `similar`. `process_papers` runs it after the reader |

### The master on a board

Under ACP the master gets the chat's board (`build(board)`, interfaces I1) and follows the pipeline in `docs/Concept.md` (Discovery and ranking pipeline):

1. `get_board` and `update_plan`; seeds not on the board yet are looked up with `get_paper` or `resolve_seed`.
2. The `search` agent once per sub-query, in parallel.
3. `score_candidates` on the whole pool, without the board's discarded papers; the harness fills in `candidate_ids`.
4. `add_papers` with the seeds and the 12 best-scored candidates, each `near` its closest seed. The harness drops papers no tool returned and fills in titles, authors, years, venues, links and `foundBy` from the tool results, so the model only picks papers and neighbours.
5. `process_papers`, which returns at once (below).
6. `rerank` on the top of the scoring (the harness fills in `paper_ids`), then `set_scores` per placed paper and board goal.
7. The answer in the chat, with papers as `[Title](paper:<id>)` links. Papers it placed but didn't hand to `process_papers` are read anyway once the turn ends.

`process_papers` (`agents/master/background.py`) first links the papers to the ones they were placed near, in one model-free `link_papers` call (kind `similar`), so each card's string shows as soon as reading starts. Then it reads each placed paper in the background, with its own runners: the `reader`; a model-free step that writes the reader's quotes (`add_quote`, which keeps only sentences from the abstract for now), its summary and what it couldn't check (`set_card` `summary`, `gaps`); then the `context` agent; then `mark_working` off. If no `set_card` from the context agent wrote `oneLine`, it runs once more with the errors it got; if it still didn't, the card's `gaps` say "The agent couldn't write why this paper matters: <reason>", and a card with `oneLine` but no glance says "The agent couldn't draw the paper at a glance." Any other failed step still clears the badge and says why in `gaps`. Every failed tool call in a background pass is logged at WARNING as `background <paperId> <agent> <tool>: <error>`, so the log says why a card has a gap. At most 3 papers are read at a time and the background agents make at most 30 model calls a minute, since Token Factory's limit is shared. Background writes carry the run ID of the turn that placed the paper and the researcher's member ID, like the turn's own writes. Closing the chat stops the passes still running, and each clears its badge.

### The reader's artifacts

On the board, `process_papers` writes them to the card; in the chat, the master answers with them:

| Field | On the card |
| --- | --- |
| `summary` | `set_card` `summary` |
| `quotes`, `highlights` (`text`) | `add_quote`, for the passages that are word for word in the abstract |
| `source` `abstract` | `set_card` `gaps`: "Read from the abstract only" |
| `tldr`, `highlights`, `summary` | The context agent's request, for `oneLine`, claims and glance |
| `figures` (`figureId`, `label`, `why`) | Not yet: `set_card` takes a figure with an image URL, which `get_fulltext` doesn't give |

`source` says what it read: `pmc` or `web` for the full text, `abstract` when no full text was found, which `notes` then says too.

## The ACP adapter: `python -m harness`

The board service pipes each chat panel to one `python -m harness` process, which speaks [ACP](https://agentclientprotocol.com) on stdio ([T04](../docs/wps/tldraw-integration/T04-acp-adapter.md)). Each ACP session gets its agent built with that session's board tools, and every prompt streams back as ACP updates: message and thought chunks, the plan, and a tool card for every tool call, including calls inside sub-agents, each with its model, time and cost. Stop cancels the turn. Nothing but ACP reaches stdout; logs go to stderr (`LOG_LEVEL`, default `INFO`).

```zsh
uv run python -m harness --echo                   # no model, no keys: plan, one tool card, the prompt echoed back
uv run python -m harness                          # HARNESS_AGENT, default master, on Super VL
HARNESS_MODEL=scripted:script.json uv run python -m harness   # every agent replays recorded turns, no keys
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `HARNESS_AGENT` | `master` | `master`, `board_assistant`, `echo`, any `harness/agents/<name>`, or `module:function` |
| `HARNESS_MODEL` | unset | `scripted:<path>`: a JSON file of turns per agent name (format in `harness/acp/scripted.py`) |
| `BOARD_INTERNAL_URL` | unset | Origin used to reach the canvas MCP instead of the one the browser sent; the board service sets it |
| `MODEL_PRICES_JSON` | unset | Override USD per million input and output tokens, e.g. `{"nvidia/Nemotron-3.5-Super-VL": [0.3, 0.9]}` |

| Path | What it is |
| --- | --- |
| `harness/__main__.py` | Stdout guard, flags, SIGTERM and stdin-close shutdown |
| `harness/acp/` | `adapter.py` (the ACP agent), `worker.py` (one task per session owns the runner and its MCP toolsets), `mapping.py` (prompt blocks to the message, events to updates), `trace.py` (tool cards), `scripted.py`, `prices.py` |
| `harness/board/` | `tools.py` (`BoardTools`: canvas, papers, viewer, plan), `viewer.py` (`focus`, `highlight`, `open_paper`, `tour`: `_canvas/*` notifications to this chat's browser only), `assistant.py` (`board_assistant`), `prompts.py` (canvas rules and context tags for instructions), `echo.py`, `ids.py` |

To give an agent the board, take a `BoardTools` in `build` (interfaces I1); the adapter passes it when the signature asks for it:

```python
def build(board: BoardTools | None = None) -> LlmAgent:
    board = board or BoardTools.from_env()   # adk web: CANVAS_MCP_URL, BOARD_TOKEN
    return LlmAgent(..., tools=[board.canvas("add_papers", "link_papers"), board.papers("search"), *board.viewer(), board.plan()])
```

To try it in an ACP client such as Zed, add a [custom agent](https://zed.dev/docs/ai/external-agents#custom-agents) with `"command": "uv", "args": ["run", "--project", "<repo>/harness", "python", "-m", "harness"]`. Plain clients send no canvas MCP, so the agent simply has no canvas tools.

Tests: `uv run pytest` runs the adapter as a real subprocess against scripted models and stand-in canvas and papers MCPs (`tests/test_acp_*.py`), no keys needed. `uv run pytest -m live` runs `board_assistant` on Super VL through the same subprocess (`tests/live/`); it skips unless the harness finds `TF_API_KEY`. `tests/fixtures/echo-session.jsonl` is a recorded echo session for the chat panel's tests.

## Not built yet

- Verdicts, citation overlap and recency in `score_candidates`: it scores by embedding similarity to the question and the closest seed, so the master places the top of that score. The master's instruction already skips candidates marked `placeable: false` once the papers MCP sends that field.
- Clustering (`cluster_papers`, `apply_clusters`, `label_cluster`): neither MCP has the tools yet, so the master doesn't cluster.
- Figures on the card: `get_fulltext` lists PMC figures by label and caption but no image URL, which `set_card` needs; the reader picks figures from their captions, not by looking at them.
- Full-text quotes on the card: the canvas MCP's `add_quote` only accepts sentences from the abstract, so the reader's full-text quotes are left out.
- Tool cards for the background passes: they run after the turn, so the chat shows no cards for them; the board shows their progress with the reading badge.
