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

Pick an agent in the dev UI and chat with it; the events panel shows each tool call and result. `uv run adk run harness/agents/search` does the same in the terminal.

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
| `search` | Lightning | papers `search`, `find_candidates` | Built; runs one sub-query and answers with candidate IDs as JSON |
| `master`, `reader`, `context` | see `docs/Concept.md` | | To do |

## The ACP adapter: `python -m harness`

The board service pipes each chat panel to one `python -m harness` process, which speaks [ACP](https://agentclientprotocol.com) on stdio ([T04](../docs/wps/tldraw-integration/T04-acp-adapter.md)). Each ACP session gets its agent built with that session's board tools, and every prompt streams back as ACP updates: message and thought chunks, the plan, and a tool card for every tool call, including calls inside sub-agents, each with its model, time and cost. Stop cancels the turn. Nothing but ACP reaches stdout; logs go to stderr (`LOG_LEVEL`, default `INFO`).

```zsh
uv run python -m harness --echo                   # no model, no keys: plan, one tool card, the prompt echoed back
uv run python -m harness                          # HARNESS_AGENT, default board_assistant, on Super VL
HARNESS_MODEL=scripted:script.json uv run python -m harness   # every agent replays recorded turns, no keys
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `HARNESS_AGENT` | `board_assistant` | `board_assistant`, `echo`, any `harness/agents/<name>`, or `module:function` |
| `HARNESS_MODEL` | unset | `scripted:<path>`: a JSON file of turns per agent name (format in `harness/acp/scripted.py`) |
| `BOARD_INTERNAL_URL` | unset | Origin used to reach the canvas MCP instead of the one the browser sent; the board service sets it |
| `MODEL_PRICES_JSON` | unset | Override USD per million input and output tokens, e.g. `{"nvidia/Nemotron-3.5-Super-VL": [0.3, 0.9]}` |

| Path | What it is |
| --- | --- |
| `harness/__main__.py` | Stdout guard, flags, SIGTERM and stdin-close shutdown |
| `harness/acp/` | `adapter.py` (the ACP agent), `worker.py` (one task per session owns the runner and its MCP toolsets), `mapping.py` (prompt blocks to the message, events to updates), `trace.py` (tool cards), `scripted.py`, `prices.py` |
| `harness/board/` | `tools.py` (`BoardTools`: canvas, papers, viewer, plan), `assistant.py` (`board_assistant`), `prompts.py` (canvas rules and context tags for instructions), `echo.py`, `ids.py` |

To give an agent the board, take a `BoardTools` in `build` (interfaces I1); the adapter passes it when the signature asks for it:

```python
def build(board: BoardTools | None = None) -> LlmAgent:
    board = board or BoardTools.from_env()   # adk web: CANVAS_MCP_URL, BOARD_TOKEN
    return LlmAgent(..., tools=[board.canvas("add_papers", "link_papers"), board.papers("search"), *board.viewer(), board.plan()])
```

To try it in an ACP client such as Zed, add a [custom agent](https://zed.dev/docs/ai/external-agents#custom-agents) with `"command": "uv", "args": ["run", "--project", "<repo>/harness", "python", "-m", "harness"]`. Plain clients send no canvas MCP, so the agent simply has no canvas tools.

Tests: `uv run pytest` runs the adapter as a real subprocess against scripted models and stand-in canvas and papers MCPs (`tests/test_acp_*.py`), no keys needed. `uv run pytest -m live` runs `board_assistant` on Super VL through the same subprocess (`tests/live/`); it skips unless the harness finds `TF_API_KEY`. `tests/fixtures/echo-session.jsonl` is a recorded echo session for the chat panel's tests.

## Not built yet

- Background reader and context passes (`process_papers`).
- Labelling each trace step with its model and time for the demo.
