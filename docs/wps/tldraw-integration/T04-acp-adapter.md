# T04: ACP adapter: `python -m harness`

| Field | Value |
| --- | --- |
| Lane | Harness, board half |
| Size | M |
| Depends on | [I1](interfaces.md#i1-agent-factory-takes-the-boards-tools) agreed with the harness owner (the adapter works with today's `search` agent and our `board_assistant` without it) |
| Unblocks | T03 (echo mode), T05, T06, T07, T12 |
| Milestone | M1 |
| Status | Not started |
| Owner | TBD |

## Goal

`python -m harness` is an ACP agent on stdio. For each ACP session it builds the chosen ADK agent with that session's board tools, runs every prompt through an ADK runner, and streams what happens as ACP updates: message chunks, thoughts, a plan, and a tool card for every tool call, including calls made inside sub-agents. Stop cancels cleanly. Nothing but ACP ever reaches stdout.

## Context

- [Architecture diagram 1](../../architecture.html#components): the harness behind the ACP pipe; [diagram 2](../../architecture.html#run), step 15: "streamed plan, tool cards and messages (ACP)".
- [Concept: Harness: ADK behind ACP](../../Concept.md#acp-one-researchers-conversation) has the sketch and the "How ADK events become ACP updates" table this WP implements; [Protocol gotchas](../../Concept.md#protocol-gotchas) lists the traps.
- `harness/README.md` lists "The ACP adapter (`python -m harness`)" under "Not built yet".

## Scope

**In:** the ACP agent and its session workers; ADK-to-ACP mapping; ACP-to-`genai` prompt mapping (text and resources here, images with T07); the tool-card plugin; `BoardTools` ([I1](interfaces.md#i1-agent-factory-takes-the-boards-tools)); `update_plan` ([I3](interfaces.md#i3-plans-go-through-a-tool)); run IDs; echo and scripted modes; the `board_assistant` agent; tests.

**Out:** the viewer tools' bodies (T06; this WP leaves `BoardTools.viewer()` returning `[]`); the master agent and its prompt (harness owner); `session/load` and resume.

## Design

**Files** (all new, under `harness/harness/`):

| File | Contents |
| --- | --- |
| `__main__.py` | Flags and environment, stdout guard, `asyncio.run(main())` |
| `acp/adapter.py` | `BoardHarness`, the ACP `Agent`: `initialize`, `new_session`, `prompt`, `cancel` |
| `acp/worker.py` | `SessionWorker`: one long-lived task per ACP session that owns the runner and its MCP toolsets |
| `acp/mapping.py` | `to_genai_content(blocks)`, `EventMapper` (ADK events to ACP updates for one prompt) |
| `acp/trace.py` | `AcpTracePlugin`: ADK plugin turning tool callbacks into `tool_call` and `tool_call_update` |
| `acp/images.py` | The image plugin from [T07](T07-board-context.md): puts snapshots the agent asked for into the next model call |
| `acp/scripted.py` | `ScriptedModel` for `HARNESS_MODEL=scripted:<path>` (same idea as `tests/conftest.py`'s `ScriptedLlm`) |
| `board/tools.py` | `BoardTools` (canvas, papers, viewer, plan) |
| `board/ids.py` | `paper_shape_id`, `new_run_id` |
| `board/assistant.py` | `board_assistant`: a small agent that answers about the board, adds notes and papers, and calls `search` as a tool |
| `board/echo.py` | The echo agent: no model, deterministic output for pipe and panel tests |

**Dependency.** `agent-client-protocol==0.12.1` in `harness/pyproject.toml` (import name `acp`).

**`initialize`.** Reply with `PROTOCOL_VERSION`; capabilities: `mcp_capabilities.http = true`, `prompt_capabilities.image = true`, `prompt_capabilities.embedded_context = true`, `load_session = false`; `agent_info` with name `paper-canvas-harness` and the package version.

**`new_session(cwd, mcp_servers)`.**

1. Find the HTTP MCP server named `canvas`; take its URL and headers. If `BOARD_INTERNAL_URL` is set, swap the URL's origin for it.
2. Build `BoardTools(board_id, member_id, canvas_url, canvas_headers, papers_url=PAPERS_MCP_URL, conn, session_id)`.
3. Pick the factory from `HARNESS_AGENT` (`board_assistant` by default, `echo`, or any `harness.agents.<name>.agent.build`); pass `board` if `build` accepts it ([I1](interfaces.md#i1-agent-factory-takes-the-boards-tools)). If `HARNESS_MODEL=scripted:<path>`, replace the model on every agent in the tree.
4. Start a `SessionWorker` task; return `session_id` (`s_` plus 12 hex).

No canvas server in the request is allowed (the agent just has no canvas tools), so the harness also works from plain ACP clients such as Zed.

**`SessionWorker`.** MCP sessions must be closed in the task that opened them, so one task per ACP session owns everything:

```python
async def run(self) -> None:
    runner = Runner(app=App(name="board", root_agent=self.agent, plugins=[self.trace, self.images]),
                    session_service=InMemorySessionService())
    session = await runner.session_service.create_session(
        app_name="board", user_id=self.board.member_id, state={"board_id": self.board.board_id})
    try:
        while (job := await self.jobs.get()) is not None:
            job.result.set_result(await self.run_prompt(runner, session.id, job))
    finally:
        await runner.close()  # closes the McpToolsets in this same task
```

`prompt()` puts a job on the queue and awaits its result; prompts in one session run one at a time. Stdin closing or the process getting `SIGTERM` puts `None` on every queue and waits up to 3 seconds.

**One prompt.**

- `run_id = new_run_id()`; `runner.run_async(user_id, session_id, new_message=to_genai_content(blocks), state_delta={"run_id": run_id}, run_config=RunConfig(streaming_mode=StreamingMode.SSE), abort_signal=job.abort)`.
- The canvas toolset is an `McpToolset` with `header_provider=lambda ctx: {**auth, "X-Run-Id": ctx.state.get("run_id"), "X-Model": model_of(ctx.agent_name)}`, so every canvas call in this turn carries the run ID and the calling agent's model, and the model never sees either (decision D7). The card's "AI" labels use `X-Model` (T10).
- `cancel(session_id)` sets `job.abort`; the prompt returns `stop_reason="cancelled"`, and the trace plugin marks any open tool card `failed` with "cancelled". Otherwise `end_turn`; an exception becomes an agent message "Something went wrong: …" plus `end_turn`, and the full traceback goes to stderr.

**ADK events to ACP updates** (`EventMapper`, one per prompt):

| ADK | ACP `session/update` | Notes |
| --- | --- | --- |
| Partial event with text | `agent_message_chunk` (the delta) | Streaming mode SSE |
| Final event with text | `agent_message_chunk` only if no partials were sent for it | Avoids sending the text twice |
| Part with `thought = true` | `agent_thought_chunk` | Super VL's reasoning: Token Factory returns it as `reasoning_content` and ADK turns it into thought parts, also in partial events (checked Oct 18). Never shown as answer text |
| `update_plan` call | `plan` with `entries` | The call itself gets no tool card ([I3](interfaces.md#i3-plans-go-through-a-tool)) |
| Function calls and responses in events | nothing | Tool cards come only from the plugin, so nothing is duplicated |
| `usage_metadata` | `usage_update` | Optional; shown as a token count in the panel |

**Tool cards** (`AcpTracePlugin`, decision D8):

| Callback | ACP update |
| --- | --- |
| `before_tool_callback` | `tool_call` with `toolCallId = tool_context.function_call_id`, `title = "<agent>: <tool>"`, `kind` (below), `status = "in_progress"`, `rawInput = args`, `_meta: {agent, model, runId}` |
| `after_tool_callback` | `tool_call_update`, `status = "completed"`, `rawOutput` (truncated to 8 KB), a one-line text summary, and `_meta: {seconds, tokens, costUsd}` for v4's "model, time and cost" line |
| `on_tool_error_callback` | `tool_call_update`, `status = "failed"`, the error message |

Time is the tool's wall-clock duration. Tokens and cost come from the plugin's `after_model_callback`, which sums `usage_metadata` of the model calls made inside the tool's span (so a sub-agent's card carries its whole cost), priced from a small table in `harness/harness/acp/prices.py` (USD per million input and output tokens per model, filled from Token Factory's price list, overridable with `MODEL_PRICES_JSON`). Each turn ends with a `usage_update` carrying the session's running `cost`.

`kind`: canvas writes are `edit`; `get_*` tools are `read`; `search` and `find_candidates` are `search`; Tavily extract is `fetch`; sub-agents called as tools are `think`; anything else is `other`. Viewer tools and `update_plan` get no card. The `model` label comes from a name-to-model map built by walking the agent tree, including agents inside `AgentTool`, so each card names the Nemotron model that actually ran (Super VL or Lightning), which is what the Best use of Nemotron judging wants to see.

**Prompt blocks to `genai`** (`to_genai_content`): text becomes a text part; an embedded `resource` becomes a text part `<board-context uri="…">…</board-context>`; an `image` becomes `inline_data` (T07 finishes the image rules, [I6](interfaces.md#i6-which-model-slots-take-images)); a `resource_link` becomes a text part with the URI.

**Stdout guard** (`__main__.py`). Before anything else imports: duplicate fd 1 for ACP, then point fd 1 and `sys.stdout` at stderr, so a stray `print` or a library banner can't corrupt the stream. Build the ACP writer on the duplicate the same way `acp.stdio.stdio_streams` builds its pair in 0.12.1, and pass the pair to `run_agent(agent, input_stream=…, output_stream=…)`. Logging goes to stderr at `INFO`, with `LOG_LEVEL` to change it.

**Echo mode** (`HARNESS_AGENT=echo`, or `python -m harness --echo`). No model and no keys: for each prompt it sends a two-step plan, one tool card that goes `in_progress` then `completed`, `_canvas/focus` for any selected shapes in the prompt (once T06 exists), and the prompt's text back as message chunks. T03 and T05 build against it.

**`board_assistant`.** `LlmAgent` on `models.super_vl()`, Nemotron 3.5 Super VL, so it can see the board and papers (T07), with `board.canvas("get_board", "add_papers", "add_note", "link_papers")`, `AgentTool(search.build())`, `*board.viewer()` (focus, highlight, open paper, and T07's look tools) and `board.plan()`. Its instruction follows [I4](interfaces.md#i4-how-agents-use-the-canvas). It exists to prove the wiring and is the agent every live test runs; the harness owner's `master` replaces it as the default when ready.

**Live agent tests on Super VL.** Scripted tests prove the plumbing; live tests prove the model does its part. `harness/tests/live/` holds tests marked `@pytest.mark.live`, skipped unless `TF_API_KEY` is set and run with `uv run pytest -m live`. They use `board_assistant` on Super VL against the fake canvas and papers MCPs, through the real ACP adapter in a subprocess, and each keeps to a few model calls (the starting rate limit is 60 requests a minute):

| Test | Passes when |
| --- | --- |
| Tool calling | "Add a note saying the CD8 cluster needs a review" makes Super VL call `add_note` with that text, and the answer confirms it |
| Nested tools | "Find two papers on exhausted CD8 T cells and add them" produces tool cards for `search: search` and `board_assistant: add_papers` |
| Thoughts kept apart | Thought chunks arrive, and no final message chunk contains reasoning (no text from thought parts) |
| Vision | The board and figure checks in [T07](T07-board-context.md#tests) |
| Cancel | Stop during a live turn returns `cancelled` within 2 seconds |

Assertions are about behaviour (which tool was called, which names appear), not exact wording.

## Tasks

- [ ] `harness/pyproject.toml`: `agent-client-protocol==0.12.1`; `uv lock` (agree with the harness owner first).
- [ ] `board/ids.py` and `tests/test_board_ids.py` against `client/shared/fixtures/paper-ids.json`.
- [ ] `board/echo.py`, `acp/adapter.py` and `__main__.py` with the stdout guard: echo mode end to end (unblocks T03 and T05).
- [ ] `acp/worker.py`, `acp/mapping.py`, `acp/trace.py`, `acp/scripted.py`.
- [ ] `board/tools.py` (with `viewer()` returning `[]` until T06), `board/assistant.py`.
- [ ] `tests/live/` with the `live` marker registered in `pyproject.toml` (`addopts = "-m 'not live'"`, so plain `pytest` stays keyless).
- [ ] `harness/README.md`: replace "Not built yet: the ACP adapter" with how to run and test it; mention trying it in an ACP client such as Zed.
- [ ] `.env.example`: `HARNESS_AGENT`, `HARNESS_MODEL` (harness section).

## Acceptance criteria

1. `HARNESS_AGENT=echo uv run python -m harness` completes `initialize`, `session/new` and `session/prompt` with an ACP client and returns `end_turn`, with no keys set.
2. With the scripted model and the fake canvas MCP from the tests, one prompt produces, in order: a `plan`, a tool card for `search: search` (made inside the `search` sub-agent), a tool card for `board_assistant: add_papers`, message chunks, and `end_turn`.
3. Every canvas call in one prompt carries the same `X-Run-Id`; the next prompt gets a new one.
4. `session/cancel` during a slow tool returns `cancelled` within 2 seconds, and stderr shows no "exit cancel scope in a different task" error.
5. A tool that calls `print()` doesn't corrupt the stream (the test reads stdout line by line and every line parses as JSON).
6. With `TF_API_KEY` set, `uv run pytest -m live` passes on Super VL, and the same flow runs against `discovery` and the board service (T02) with the cards appearing on the board.

## Tests

- `tests/test_acp_mapping.py`: prompt blocks to `genai` parts; partial and final text without duplicates; thoughts; plan.
- `tests/test_acp_adapter.py`: spawns `python -m harness` as a real subprocess with `HARNESS_MODEL=scripted:…` and a fake canvas MCP (same pattern as `FakePapers` in `conftest.py`), drives it with the ACP Python SDK's client side, and checks criteria 2 to 5.
- `tests/test_board_ids.py`: shape ID parity with TypeScript.

## Risks

- **Streaming with tool calls through LiteLLM** has been fragile; if Nemotron streaming breaks tool calls, run with streaming mode off (a constant in `worker.py`), at the cost of whole-message chunks. Streaming of thoughts and text on Super VL was checked on Oct 18; streaming with tool calls is covered by the live tests.
- **Reasoning latency:** Super VL thinks before answering. The thoughts stream to the panel so the wait is visible; for quick viewer replies the harness owner can turn reasoning off per agent ([I8](interfaces.md#i8-token-factory-notes-for-the-harness-owner)).
- **`header_provider` and session caching:** ADK keys MCP sessions by header identity, so a new run ID opens a new MCP session per prompt. The canvas MCP is stateless (T02), so this is cheap; ADK caps the cache.
- **Plugin inheritance:** criterion 2 fails loudly if a future ADK stops passing plugins into `AgentTool`; the fix then is attaching the same callbacks to each agent through `BoardTools`.

## References

- [ACP overview](https://agentclientprotocol.com/protocol/overview), [prompt turn](https://agentclientprotocol.com/protocol/prompt-turn), [tool calls](https://agentclientprotocol.com/protocol/tool-calls), [agent plan](https://agentclientprotocol.com/protocol/agent-plan), [extensibility](https://agentclientprotocol.com/protocol/extensibility)
- [ACP Python SDK](https://github.com/agentclientprotocol/python-sdk) and its [example agent](https://github.com/agentclientprotocol/python-sdk/blob/main/examples/agent.py)
- [ADK plugins](https://adk.dev/plugins/), [ADK MCP tools](https://adk.dev/tools-custom/mcp-tools/)
