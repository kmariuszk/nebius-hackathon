# H02: Clean the tool arguments the model writes as text

| Field | Value |
| --- | --- |
| Lane | Harness |
| Size | S |
| Priority | P0 |
| Depends on | — |
| Unblocks | H04 |
| Milestone | W1 Nothing broken |
| Status | Built (Oct 20, `w1/harness-args`). In the Wave 1 gate run on `w1/integration` (Oct 21, Super VL, cold cache, five demo seeds, report `20261021T160203Z`): 0 placeholder arguments reached the papers MCP and each search agent made 3 calls before `done`; Super VL wrote none that run, so the cleaning itself is proven by the scripted tests |
| Owner | TBD |

## Goal

No placeholder string the model writes for an optional argument ("None", "null", "") ever reaches an MCP tool. The search agent's calls then return what the sources have, and it finishes in three calls or fewer per sub-query.

## Context

- Finding F1 (Oct 19 live run): Nemotron Lightning, in the search agent, sent `since: "None"`, `sources: "None"` and `exclude_ids: "None"` as strings. The papers MCP accepted `since`, so PubMed got `mindate=None` and silently returned nothing, OpenAlex and Tavily answered HTTP 400, `_pubmed_links` crashed on `int('None')` and `citing` answered 400. One sub-query got no keyword results, and that search agent kept retrying with new wordings: over a dozen calls instead of three or fewer. The list arguments were rejected by validation, which cost a retry each.
- The papers MCP gets its own guard in [D01](../discovery/D01-validate-optional-arguments.md). This WP fixes it at the source, for every MCP tool every agent calls, including the canvas MCP.
- ADK 2.12's `McpTool.raw_mcp_tool` gives the MCP tool's `inputSchema`, including `required`.

## Scope

**In:** a before-tool callback that drops placeholder values from optional arguments of MCP tools; wiring it into every agent; one line in the search agent's instruction; tests.

**Out:** validating values on the server (D01); function tools defined in the harness (`done`, `update_plan`, `process_papers`, `rank_papers`), whose arguments are typed Python.

## Design

**`harness/harness/agents/args.py`:**

```python
PLACEHOLDERS = frozenset({"None", "none", "null", "NULL", "undefined", ""})

def clean_args(*, tool: BaseTool, args: dict[str, Any], tool_context: ToolContext) -> None:
    """Drop optional MCP arguments the model wrote as a placeholder string."""

def chain(*callbacks) -> Callable[..., dict[str, Any] | None]:
    """Run before-tool callbacks in order; the first one that returns a dict wins."""
```

- Only `McpTool`s are touched (`isinstance(tool, McpTool)`); their schema is `tool.raw_mcp_tool.inputSchema`. An argument is dropped when its name is not in `required` and its value is a string in `PLACEHOLDERS`.
- Required arguments are left alone, so the server's validation error tells the model what to fix. Empty lists and dicts are kept: `candidates.fill` replaces `paper_ids: []` and `candidate_ids: []` after this callback.
- Each dropped argument is logged at DEBUG (`dropped since="None" from search`); a turn's count goes in one INFO line.
- `chain` exists because the master already has `candidates.fill` (board) or `candidates.fill_rerank` (no board) as its before-tool callback: the master gets `chain(clean_args, candidates.fill)`.

**Where it's wired:**

| Agent | File | Before-tool callback |
| --- | --- | --- |
| `search` | `harness/harness/agents/search/agent.py` | `clean_args` |
| `master` (no board, board) | `harness/harness/agents/master/agent.py` | `chain(clean_args, candidates.fill_rerank)` and `chain(clean_args, candidates.fill)` |
| `reader` | `harness/harness/agents/reader/agent.py` | `clean_args` |
| `context` | `harness/harness/agents/context/agent.py` | `clean_args` |
| `board_assistant` | `harness/harness/board/assistant.py` | `clean_args` |

`SearchTool` builds a fresh search agent per call through `search.build()`, so the callback comes with it.

**Instruction.** The search agent's instruction gains one sentence after the call budget: "Leave out optional arguments you don't use; never write None or null for them."

## Tasks

- [x] `harness/harness/agents/args.py`: `PLACEHOLDERS`, `clean_args`, `chain`.
- [x] Wire it into the five agents above.
- [x] One sentence in `search/agent.py`'s `INSTRUCTION`.
- [x] `harness/tests/test_args.py`.
- [x] A scripted case in `harness/tests/test_search_agent.py`.

## Acceptance criteria

1. A scripted search turn whose model calls `search(query=…, since="None", sources="None")` reaches the stand-in papers MCP as `search(query=…)` with no `since` and no `sources`.
2. A required argument written as `"None"` is passed through unchanged, and an optional `paper_ids: []` is kept.
3. In the [H01](H01-live-board-check.md) report, `placeholderArgs` is 0 and every search agent makes three tool calls or fewer before `done`.

## Tests

- `harness/tests/test_args.py`: a fake `McpTool` with an `inputSchema` (`required: ["query"]`); cases for each placeholder, a required placeholder, empty lists, a function tool (untouched), and `chain` ordering (a callback that returns a dict stops the chain).
- `harness/tests/test_search_agent.py`: the scripted case above, asserting on the stand-in MCP's recorded calls.

## Risks

- **A real value that looks like a placeholder** (a query literally "None"): only optional arguments are cleaned, and none of them take free text that could be "None".
- **ADK renames `raw_mcp_tool`:** it is a public property in 2.12; if it moves, `_get_declaration().parameters_json_schema` is the fallback.

## References

- [Discovery D01: validate optional arguments](../discovery/D01-validate-optional-arguments.md)
- [Group README: argument cleaning](README.md#shared-contracts)
