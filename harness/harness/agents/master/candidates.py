"""The conversation's candidate pool: paper IDs taken from tool results, never retyped by a model.

Each `search` agent run records the IDs its `search` and `find_candidates`
calls returned in the master's session state, one entry per tool result. When
the master calls `rerank`, `paper_ids` is replaced with the merged pool, so an
ID a model copied wrong (say `doi:1136/…` for `doi:10.1136/…`) never reaches
the ranking, and later turns rank old and new candidates together.

On a board the master also notes what its own tools return (`note`): paper
details, the board's papers and discarded papers, the scored order, what it
placed and near which paper. `fill` then gives `score_candidates` the pool without the
discarded papers, gives `rerank` the top of the latest scoring, and swaps the
titles and links in `add_papers` for the ones the tools returned.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from functools import partial
from typing import Any

from google.adk.agents import LlmAgent
from google.adk.tools.agent_tool import AgentTool
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.tool_context import ToolContext

log = logging.getLogger(__name__)

# Session state keys: one per tool result, `candidates:<call ID>:<n>`. Separate
# keys keep parallel search runs from overwriting each other's results.
PREFIX = "candidates:"
# The same, for paper details (`papers:`), get_board (`board:`), the order
# score_candidates gave (`scored:`), the cards add_papers wrote (`placed:`) and
# the paper each was placed near (`near:`).
PAPERS, BOARD, SCORED, PLACED, NEAR = "papers:", "board:", "scored:", "placed:", "near:"
QUESTION = "question"
# What add_papers takes from the tools' paper records; the model gives paperId, near and kind.
CARD_FIELDS = ("title", "authors", "year", "venue", "url", "type", "foundBy")
FROM_SEEDS = "expanded from the seeds"


class FreshAgentTool(AgentTool):
    """An agent as a tool, built fresh for every call.

    `AgentTool` closes its agent's MCP toolset when a run ends, so parallel
    calls sharing one agent would cut each other's MCP session. A fresh agent
    per call has its own toolset.
    """

    def __init__(self, build: Callable[[], LlmAgent]) -> None:
        super().__init__(agent=build())
        self._build = build

    async def run_async(self, *, args: dict[str, Any], tool_context: ToolContext) -> Any:
        return await self.run_agent(self._build(), args, tool_context)

    async def run_agent(self, agent: LlmAgent, args: dict[str, Any], tool_context: ToolContext) -> Any:
        run = AgentTool(agent=agent, include_plugins=self.include_plugins)
        return await run.run_async(args=args, tool_context=tool_context)


class SearchTool(FreshAgentTool):
    """The search agent as a tool, built fresh for every call, adding the IDs it finds to the pool."""

    async def run_async(self, *, args: dict[str, Any], tool_context: ToolContext) -> Any:
        answer: dict[str, Any] = {}
        found: dict[str, str] = {}
        agent = self._build()
        agent.after_tool_callback = partial(record, tool_context, answer, found)
        text = await self.run_agent(agent, args, tool_context)
        # A run that ends with `done` has no text reply, so AgentTool returns "";
        # the answer `done` accepted is the result.
        return grounded(answer, found) if answer else text


def record(
    parent: ToolContext,
    answer: dict[str, Any],
    found: dict[str, str],
    *,
    tool: BaseTool,
    args: dict[str, Any],
    tool_context: ToolContext,
    tool_response: Any,
) -> None:
    """After a search agent's tool call: add the IDs it returned to the master's pool
    and to `found` (by lowercase ID), and keep the answer `done` accepted."""
    if tool.name == "done" and isinstance(tool_response, dict) and "error" not in tool_response:
        answer.update(tool_response)
    ids = paper_ids(tool.name, tool_response)
    if ids:
        found.update((paper_id.lower(), paper_id) for paper_id in ids)
        key = f"{parent.function_call_id}:{count(parent, parent.function_call_id)}"
        parent.state[PREFIX + key] = ids
        parent.state[PAPERS + key] = details(tool.name, tool_response)


def count(context: ToolContext, call_id: str | None) -> int:
    return sum(key.startswith(f"{PREFIX}{call_id}:") for key in context.state.to_dict())


def grounded(answer: dict[str, Any], found: dict[str, str]) -> dict[str, Any]:
    """The answer with only the candidates a tool returned, under the tool's own ID.

    Lightning sometimes reports papers no tool returned, with made-up PMIDs.
    """
    kept, dropped = [], []
    for candidate in answer.get("candidates", []):
        if real := found.get(str(candidate.get("paperId", "")).lower()):
            kept.append({**candidate, "paperId": real})
        else:
            dropped.append(str(candidate.get("paperId", "")))
    if not dropped:
        return {**answer, "candidates": kept}
    count = f"{len(dropped)} paper{'s' * (len(dropped) > 1)}"
    note = f"dropped {count} no tool returned: {', '.join(dropped)}"
    return {**answer, "candidates": kept, "notes": "; ".join(filter(None, [answer.get("notes"), note]))}


def paper_ids(tool_name: str, response: Any) -> list[str]:
    """The paper IDs in a `search` or `find_candidates` result, in the order returned."""
    result = structured(response)
    if tool_name == "search":
        return [paper["paperId"] for paper in result.get("papers", []) if paper.get("paperId")]
    if tool_name == "find_candidates":
        return [paper_id for paper_id in result.get("candidateIds", []) if paper_id]
    return []


def details(tool_name: str, response: Any) -> list[dict[str, Any]]:
    """Paper records in a tool result, cut to the fields a card shows."""
    result = structured(response)
    if tool_name == "find_candidates":
        return [{"paperId": i, "foundBy": [FROM_SEEDS]} for i in result.get("candidateIds", []) if i]
    if tool_name in {"get_paper", "resolve_seed"}:
        papers = [result]
    else:
        papers = result.get("papers") or result.get("top") or result.get("ranked") or []
    out = []
    for paper in papers:
        if isinstance(paper, dict) and paper.get("paperId"):
            fields = {k: paper[k] for k in CARD_FIELDS if paper.get(k) not in (None, "", [])}
            if "authors" in fields:
                fields["authors"] = [a for a in fields["authors"] if a != "et al."]
            out.append({"paperId": paper["paperId"], **fields})
    return out


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


# ---- on a board


def known(state: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Every paper a tool returned, by ID, its details merged across results."""
    papers: dict[str, dict[str, Any]] = {}
    for key, records in state.items():
        if not key.startswith(PAPERS):
            continue
        for paper in records:
            merged = papers.setdefault(paper["paperId"], {"paperId": paper["paperId"]})
            for field, value in paper.items():
                if field == "foundBy":
                    merged["foundBy"] = list(dict.fromkeys([*merged.get("foundBy", []), *value]))
                else:
                    merged.setdefault(field, value)
    return papers


def on_board(state: dict[str, Any]) -> set[str]:
    """Papers on the board: from the last `get_board`, plus every card placed since."""
    ids: set[str] = set()
    for key, value in state.items():
        if key.startswith(BOARD):
            ids = set(value["papers"])  # a later get_board supersedes an earlier one
        elif key.startswith(PLACED):
            ids |= set(value)
    return ids


def discarded(state: dict[str, Any]) -> set[str]:
    """Papers the researchers discarded, as the last `get_board` listed them."""
    boards = [value for key, value in state.items() if key.startswith(BOARD)]
    return set(boards[-1]["discarded"]) if boards else set()


def placed(state: dict[str, Any]) -> dict[str, str]:
    """Cards add_papers wrote in this conversation: paper ID to kind (seed or suggestion)."""
    cards: dict[str, str] = {}
    for key, value in state.items():
        if key.startswith(PLACED):
            cards.update(value)
    return cards


def near(state: dict[str, Any]) -> dict[str, str]:
    """The paper each card add_papers wrote in this conversation was placed near, when it named one."""
    papers: dict[str, str] = {}
    for key, value in state.items():
        if key.startswith(NEAR):
            papers.update(value)
    return papers


def scored(state: dict[str, Any]) -> list[str]:
    """The order the latest `score_candidates` returned."""
    lists = [ids for key, ids in state.items() if key.startswith(SCORED)]
    return lists[-1] if lists else []


def note(*, tool: BaseTool, args: dict[str, Any], tool_context: ToolContext, tool_response: Any) -> None:
    """After a master's tool call on a board: remember what it said about papers and the board."""
    result = structured(tool_response)
    if not result or (isinstance(tool_response, dict) and tool_response.get("isError")):
        return
    key, state = tool_context.function_call_id or tool.name, tool_context.state
    if tool.name in {"get_paper", "resolve_seed", "score_candidates", "rerank"}:
        state[PAPERS + key] = details(tool.name, tool_response)
    if tool.name == "score_candidates":
        state[SCORED + key] = [paper["paperId"] for paper in result.get("top", []) if paper.get("paperId")]
        state[QUESTION] = args.get("question", "")
    elif tool.name == "get_board":
        papers = [paper["paperId"] for paper in result.get("papers", []) if paper.get("paperId")]
        state[BOARD + key] = {"papers": papers, "discarded": result.get("discardedIds") or []}
    elif tool.name == "add_papers":
        kinds = {paper.get("paperId"): paper.get("kind") or "suggestion" for paper in args.get("papers", [])}
        nears = {paper.get("paperId"): paper["near"] for paper in args.get("papers", []) if paper.get("near")}
        written = [*result.get("added", []), *result.get("updated", [])]
        state[PLACED + key] = {paper_id: kinds.get(paper_id, "suggestion") for paper_id in written}
        state[NEAR + key] = {paper_id: nears[paper_id] for paper_id in written if paper_id in nears}


def fill(*, tool: BaseTool, args: dict[str, Any], tool_context: ToolContext) -> dict[str, Any] | None:
    """Before a master's tool call on a board: IDs and paper details from the tools, not the model."""
    state = tool_context.state.to_dict()
    dropped = discarded(state)
    if tool.name == "score_candidates" and (found := pool(state)):
        args["candidate_ids"] = [paper_id for paper_id in found if paper_id not in dropped]
    elif tool.name == "rerank" and (found := scored(state) or pool(state)):
        args["paper_ids"] = [paper_id for paper_id in found if paper_id not in dropped]
        args["exclude_ids"] = sorted({*(args.get("exclude_ids") or []), *dropped})
    elif tool.name == "add_papers":
        return fill_cards(args, known(state), on_board(state))
    return None


def fill_cards(args: dict[str, Any], papers: dict[str, dict[str, Any]], board: set[str]) -> dict[str, Any] | None:
    """Each card's title, authors, year, venue, link, type and how it was found, as the tools
    returned them; papers no tool returned are dropped, so no card shows an invented paper."""
    cards, unknown = [], []
    for card in args.get("papers") or []:
        paper = papers.get(card.get("paperId"))
        if paper is None or "title" not in paper:
            if card.get("paperId") not in board:  # updating a card already there is fine
                unknown.append(card.get("paperId"))
                continue
            paper = {}
        cards.append({**card, **paper})  # the model's near and kind, the tools' details
    if unknown:
        log.warning("add_papers: dropped papers no tool returned: %s", ", ".join(map(str, unknown)))
    if not cards:
        return {"error": f"No tool returned these papers: {', '.join(map(str, unknown))}. "
                "Use paper IDs exactly as search, score_candidates, rerank or get_paper gave them."}
    args["papers"] = cards
    return None
