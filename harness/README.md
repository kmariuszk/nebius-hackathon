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

Pick `master` in the dev UI to talk to the full discovery loop (a question, optionally with seed DOIs or PMIDs; a first answer takes about two minutes), or `search` to try one sub-query. The events panel shows each tool call and result. `uv run adk run harness/agents/master` does the same in the terminal.

```zsh
uv run python -m harness.check   # Token Factory models, tool calling on both models, both MCP servers
uv run pytest                    # offline tests
```

## Add an agent

1. Copy an existing agent: `cp -r harness/agents/search harness/agents/reader`. The folder name must be a valid Python identifier.
2. In `agent.py`, set the name, description, model, instruction and tools. Name only the tools the agent needs:

   ```python
   def build() -> LlmAgent:
       return LlmAgent(
           name="reader",
           description="Reads one paper on its own and writes its summary and quotes to the board.",
           model=models.super_vl(),
           instruction=INSTRUCTION,
           tools=[toolsets.papers("get_fulltext", "get_figures"), toolsets.canvas("set_summary", "add_quote")],
       )

   root_agent = build()
   ```

3. Restart `adk web`; the new folder shows up in the agent list.
4. To call it from another agent, add `AgentTool(agent=reader.build())` (from `google.adk.tools.agent_tool`) to that agent's tools, or pass it in `sub_agents`.
5. Add a test next to `tests/test_search_agent.py`: script the model's turns with `call(...)` and `say(...)` and assert on the MCP calls.

## Agents

| Agent | Model | Tools | Status |
| --- | --- | --- | --- |
| `master` | Super VL | `search` agent (as a tool, a fresh one per call), papers `resolve_seed`, `get_paper`, `rerank` | Built; chats with the researcher, runs about three sub-queries in parallel and reranks every candidate they found. Candidate IDs go from the tool results to `rerank` without a model retyping them (`agents/master/candidates.py`). No canvas tools yet |
| `search` | Lightning | papers `search`, `find_candidates` | Built; runs one sub-query and answers with its picks as JSON; the IDs its tools return go to the master's candidate pool |
| `reader`, `context` | see `docs/Concept.md` | | To do |

## Not built yet

- The ACP adapter (`python -m harness`) that the board service will pipe the chat panel to; `docs/Concept.md` (Harness: ADK behind ACP) has the sketch.
- Placing papers on the board: the master answers in the chat until the canvas MCP exists.
- A numeric relevance score (`score_candidates`, from embeddings, citation overlap and recency). The master ranks with the papers MCP's `rerank` alone, so the order and scores are Super VL's judgement, not a formula; see [How ranking works today](../discovery/README.md#how-ranking-works-today).
- Background reader and context passes (`process_papers`).
- Labelling each trace step with its model and time for the demo.
