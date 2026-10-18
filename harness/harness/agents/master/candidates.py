"""The conversation's candidate pool: paper IDs taken from tool results, never retyped by a model.

Each `search` agent run records the IDs its `search` and `find_candidates`
calls returned in the master's session state, one entry per tool result. When
the master calls `rerank`, `paper_ids` is replaced with the merged pool, so an
ID a model copied wrong (say `doi:1136/…` for `doi:10.1136/…`) never reaches
the ranking, and later turns rank old and new candidates together.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from functools import partial
from typing import Any

from google.adk.agents import LlmAgent
from google.adk.tools.agent_tool import AgentTool
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.tool_context import ToolContext

# Session state keys: one per tool result, `candidates:<call ID>:<n>`. Separate
# keys keep parallel search runs from overwriting each other's results.
PREFIX = "candidates:"


class SearchTool(AgentTool):
    """The search agent as a tool, built fresh for every call.

    `AgentTool` closes its agent's MCP toolset when a run ends, so parallel
    calls sharing one agent would cut each other's MCP session. A fresh agent
    per call has its own toolset.
    """

    def __init__(self, build: Callable[[], LlmAgent]) -> None:
        super().__init__(agent=build())
        self._build = build

    async def run_async(self, *, args: dict[str, Any], tool_context: ToolContext) -> Any:
        agent = self._build()
        agent.after_tool_callback = partial(record, tool_context)
        run = AgentTool(agent=agent, include_plugins=self.include_plugins)
        return await run.run_async(args=args, tool_context=tool_context)


def record(
    parent: ToolContext,
    *,
    tool: BaseTool,
    args: dict[str, Any],
    tool_context: ToolContext,
    tool_response: Any,
) -> None:
    """After a search agent's tool call: add the IDs it returned to the master's pool."""
    ids = paper_ids(tool.name, tool_response)
    if ids:
        count = sum(key.startswith(f"{PREFIX}{parent.function_call_id}:") for key in parent.state.to_dict())
        parent.state[f"{PREFIX}{parent.function_call_id}:{count}"] = ids


def paper_ids(tool_name: str, response: Any) -> list[str]:
    """The paper IDs in a `search` or `find_candidates` result, in the order returned."""
    result = structured(response)
    if tool_name == "search":
        return [paper["paperId"] for paper in result.get("papers", []) if paper.get("paperId")]
    if tool_name == "find_candidates":
        return [paper_id for paper_id in result.get("candidateIds", []) if paper_id]
    return []


def structured(response: Any) -> dict[str, Any]:
    """An MCP tool result as a dict: its structured content, or its text parsed as JSON."""
    if not isinstance(response, dict):
        return {}
    if isinstance(response.get("structuredContent"), dict):
        return response["structuredContent"]
    for block in response.get("content") or []:
        try:
            value = json.loads(block.get("text", ""))
        except (AttributeError, ValueError):
            continue
        if isinstance(value, dict):
            return value
    return {}


def pool(state: dict[str, Any]) -> list[str]:
    """Every candidate found so far, those found by more tool results first.

    Ties keep each result's own order, interleaved across results, so no one
    sub-query's list crowds out the others before the rerank's cap.
    """
    lists = [ids for key, ids in state.items() if key.startswith(PREFIX)]
    count: dict[str, int] = {}
    best: dict[str, tuple[int, int]] = {}
    for which, ids in enumerate(lists):
        for position, paper_id in enumerate(dict.fromkeys(ids)):
            count[paper_id] = count.get(paper_id, 0) + 1
            best.setdefault(paper_id, (position, which))
    return sorted(count, key=lambda paper_id: (-count[paper_id], best[paper_id]))


def fill_rerank(*, tool: BaseTool, args: dict[str, Any], tool_context: ToolContext) -> None:
    """Before the master's `rerank`: rank the whole pool, not IDs the model copied."""
    if tool.name == "rerank" and (found := pool(tool_context.state.to_dict())):
        args["paper_ids"] = found
