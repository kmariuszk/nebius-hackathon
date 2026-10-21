"""`rank_papers`: the placed papers ranked for every board goal, their fit written by code.

The master used to rerank once for the question and write one `set_scores`
per paper itself, guessing the `methods` fit from that one ranking (decision
DH1 in docs/wps/agent-harness/README.md). `rank_papers` takes no arguments:
it reads what `candidates.note` kept in the session state (the placed
suggestions, the latest scored order, the question, and the goals and seeds
from the last `get_board`), reranks the pool once per goal in parallel, and
writes every placed suggestion's score for every goal. It never places a
paper: one the rerank likes that isn't on the board stays off it this turn.
Its calls run in a model-free `Step`, so they carry the turn's run ID and the
researcher's bearer.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from google.adk.agents.readonly_context import ReadonlyContext
from google.adk.tools import BaseTool, FunctionTool, ToolContext
from google.adk.tools.base_toolset import BaseToolset

from harness.agents.master import candidates
from harness.agents.master.background import Calls, Job, ProcessPapers, Step, short

log = logging.getLogger(__name__)

# What each goal looks for, after the question; any other goal by its ID.
GOALS = {"new-findings": "new results on the question", "methods": "methods the researcher could reuse"}
# The canvas's goals for a board that never set its own, if the master never called get_board.
DEFAULT_GOALS = ("new-findings", "methods")
HIGH, MEDIUM = 0.7, 0.4
WHY_CHARS = 200
LEFT_OUT = {"score": 0.2, "fit": "low", "why": "Not in the agent's top picks for this goal"}
NO_SCORE = 0.5  # the rerank ranked the paper but gave no score


class RankPapers(BaseToolset):
    """The master's `rank_papers` tool; its step runs through the background's runner."""

    def __init__(self, background: ProcessPapers) -> None:
        super().__init__()
        self.background = background
        self.tool = FunctionTool(self.rank_papers)

    async def get_tools(self, readonly_context: ReadonlyContext | None = None) -> list[BaseTool]:
        return [self.tool]

    async def rank_papers(self, tool_context: ToolContext) -> dict[str, Any]:
        """Rank the papers you placed in this chat for every board goal and write their fit on their cards.

        It reranks your placed suggestions, with the next best scored candidates, once per board
        goal, and writes each card's score, fit and one-line why for every goal. It places
        nothing. Returns `goals`: per goal ID the placed papers it ranked, best first, each with
        paperId, title, year and reason; `scored`: how many cards it wrote; and `skipped`.
        """
        state = tool_context.state.to_dict()
        pool = candidates.pool_for_rerank(state)
        cards = candidates.placed(state)
        placed = [paper_id for paper_id in pool if paper_id in cards]
        if not placed:
            return {"goals": {}, "scored": 0, "skipped": ["No papers placed in this chat to rank; place them first."]}
        board = candidates.last_board(state)
        goals = board.get("goals") or list(DEFAULT_GOALS)
        question = state.get(candidates.QUESTION) or board.get("question", "")
        seeds, dropped = candidates.seeds(state), sorted(candidates.discarded(state))
        ranked: dict[str, dict[str, dict[str, Any]]] = {}  # goal to lowercase paper ID to its rerank entry
        written: list[str] = []
        skipped: list[str] = []

        async def rerank(call: Calls, goal: str) -> None:
            try:
                result = await call("rerank", goal=goal_text(question, goal), paper_ids=pool, seed_ids=seeds,
                                    exclude_ids=dropped, k=len(pool))
            except Exception as error:
                skipped.append(f"Ranking for {goal} failed: {short(error)}")
                return
            entries = [e for e in result.get("ranked") or [] if isinstance(e, dict) and e.get("paperId")]
            if not entries:  # nothing ranked says nothing about fit: keep the cards' scores for this goal
                why = "; ".join(map(str, result.get("skipped") or [])) or "no reason given"
                skipped.append(f"Ranking for {goal} ranked no papers: {short(why)}")
                return
            ranked[goal] = {str(e["paperId"]).lower(): e for e in entries}

        async def score(call: Calls, paper_id: str) -> None:
            scores = {goal: fit(ranked[goal].get(paper_id.lower())) for goal in goals if goal in ranked}
            try:
                result = await call("set_scores", paperId=paper_id, scores=scores)
            except Exception as error:
                skipped.append(f"{paper_id}: {short(error)}")
                return
            if result.get("ok") is False:
                skipped.append(f"{paper_id}: {result.get('skipped') or 'not written'}")
            else:
                written.append(paper_id)

        async def action(call: Calls) -> None:
            await asyncio.gather(*(rerank(call, goal) for goal in goals))
            if ranked:
                await asyncio.gather(*(score(call, paper_id) for paper_id in placed))

        board_tools = self.background.board
        step = Step(name="rank_papers", tools=[board_tools.papers("rerank"), board_tools.canvas("set_scores")],
                    action=action)
        try:
            await self.background.run(step, "rank_papers", Job("", state.get("run_id"), question))
        except Exception as error:
            log.warning("rank_papers failed: %s", error)
            return {"error": f"Ranking failed: {short(error)}"}
        log.info("rank_papers: %d papers ranked for %s; %d cards scored, %d skipped",
                 len(pool), ", ".join(g for g in goals if g in ranked) or "no goal", len(written), len(skipped))
        known = candidates.known(state)
        return {
            "goals": {goal: answer(ranked[goal], placed, known) for goal in goals if goal in ranked},
            "scored": len(written),
            "skipped": skipped,
        }


def goal_text(question: str, goal: str) -> str:
    """The rerank's goal: the researcher's question plus what this board goal looks for."""
    return f"{question}\nLooking for: {GOALS.get(goal) or goal.replace('-', ' ')}".strip()


def fit(entry: dict[str, Any] | None) -> dict[str, Any]:
    """A card's score for one goal from that goal's rerank entry; `LEFT_OUT` when there is none."""
    if entry is None:
        return dict(LEFT_OUT)
    value = entry.get("score")
    number = isinstance(value, (int, float)) and not isinstance(value, bool)
    score = min(1.0, max(0.0, float(value))) if number else NO_SCORE
    why = " ".join(str(entry.get("reason") or "").split()) or "In the agent's top picks for this goal"
    return {
        "score": score,
        "fit": "high" if score >= HIGH else "medium" if score >= MEDIUM else "low",
        "why": why if len(why) <= WHY_CHARS else why[: WHY_CHARS - 1] + "…",
    }


def answer(
    entries: dict[str, dict[str, Any]], placed: list[str], known: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    """The placed papers a goal's rerank ranked, best first, for the master's answer."""
    ids = {paper_id.lower(): paper_id for paper_id in placed}
    out = []
    for key, entry in entries.items():
        if paper_id := ids.get(key):
            paper = known.get(paper_id, {})
            out.append({"paperId": paper_id, "title": entry.get("title") or paper.get("title", ""),
                        "year": entry.get("year") or paper.get("year"), "reason": entry.get("reason") or ""})
    return out
