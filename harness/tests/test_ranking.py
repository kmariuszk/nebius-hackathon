"""`rank_papers` (H04): the master's placed papers ranked for every board goal, their fit written by code,
against the stand-in canvas and papers MCPs."""

import asyncio
import time

import pytest
from google.adk.agents import LlmAgent
from google.adk.runners import InMemoryRunner
from google.genai import types

from conftest import ScriptedLlm, call, say
from harness import models
from harness.acp.adapter import build_agent
from harness.agents.master import agent as master
from harness.agents.master import background, candidates, ranking
from harness.agents.reader import agent as reader
from harness.board.tools import BoardTools

RUN_ID = "run_0123456789ab"
QUESTION = "melanoma T cells"
# What the stand-in rerank returns per goal: (paper ID, score, reason), best first. pmid:11 was scored but
# not placed; the methods ranking leaves pmid:13 out.
ORDERS = {
    "new-findings": [("pmid:13", 0.9, "Same cells."), ("pmid:11", 0.8, "Not on the board."),
                     ("pmid:14", 0.5, "Related cohort."), ("pmid:12", 0.3, "Far from the question.")],
    "methods": [("pmid:12", 0.75, "A reusable sorting protocol."), ("pmid:14", 0.45, "Similar pipeline.")],
}


@pytest.fixture(autouse=True)
def no_pacing(monkeypatch):
    monkeypatch.setattr(background.PACE, "per_minute", 1000)


def rerank_per_goal(papers_mcp, failing: str | None = None) -> list[tuple[float, float]]:
    """Swap the stand-in's rerank for one that returns ORDERS for the goal its text names; the
    `failing` goal's call errors. Returns each call's start and end, to check they overlap."""
    papers_mcp.server.remove_tool("rerank")
    spans: list[tuple[float, float]] = []

    @papers_mcp.server.tool()
    async def rerank(
        goal: str, paper_ids: list[str], seed_ids: list[str] | None = None, exclude_ids: list[str] | None = None,
        k: int = 20,
    ) -> dict:
        papers_mcp.calls.append(("rerank", {"goal": goal, "paper_ids": paper_ids, "seed_ids": seed_ids,
                                            "exclude_ids": exclude_ids, "k": k}))
        which = "methods" if ranking.GOALS["methods"] in goal else "new-findings"
        started = time.monotonic()
        await asyncio.sleep(0.2)
        spans.append((started, time.monotonic()))
        if which == failing:
            raise ValueError("Super VL timed out")
        order = [(p, s, r) for p, s, r in ORDERS[which] if p in paper_ids]  # like the real one: only what it's given
        ranked = [{"rank": i + 1, "paperId": p, "score": s, "reason": r} for i, (p, s, r) in enumerate(order)]
        return {"ranked": ranked[:k], "backend": "super_vl", "skipped": []}

    return spans


def unread() -> LlmAgent:
    """A reader that fails at once, so the background pass after the turn is quick."""
    agent = reader.build()
    agent.model = ScriptedLlm(turns=[say("Sorry, I couldn't read it.")])
    return agent


def master_turns() -> list[types.Content]:
    """Look, score, place three suggestions, read, rank, answer; no searches, so candidate_ids pass through."""
    return [
        call("get_board"),
        call("score_candidates", question=QUESTION, candidate_ids=["pmid:11", "pmid:12", "pmid:13", "pmid:14"],
             seed_ids=["pmid:9"], limit=100),
        call("add_papers", papers=[{"paperId": p, "title": "A", "near": "pmid:9"}
                                   for p in ("pmid:14", "pmid:13", "pmid:12")]),
        call("process_papers", paper_ids=[]),
        call("rank_papers"),
        say("1. [Paper pmid:13](paper:pmid:13) (2024). Same cells."),
    ]


async def turn(agent: LlmAgent, text: str) -> list:
    runner = InMemoryRunner(agent=agent, app_name="test")
    session = await runner.session_service.create_session(app_name="test", user_id="m_ana")
    message = types.Content(role="user", parts=[types.Part(text=text)])
    try:
        return [e async for e in runner.run_async(user_id="m_ana", session_id=session.id, new_message=message,
                                                  state_delta={"run_id": RUN_ID})]
    finally:
        await next(t for t in agent.tools if isinstance(t, background.ProcessPapers)).wait()
        await runner.close()


def board_master(canvas_mcp, model: ScriptedLlm) -> LlmAgent:
    board = BoardTools("b_test", "m_ana", canvas_mcp.url, {"Authorization": "Bearer m_ana"})
    agent = master.build(board, reader_agent=unread)
    agent.model = model
    return agent


def scores_by_paper(canvas_mcp) -> dict[str, dict]:
    return {c["args"]["paperId"]: c["args"]["scores"] for c in canvas_mcp.calls if c["tool"] == "set_scores"}


async def test_rank_papers_ranks_every_placed_paper_for_every_goal_and_places_nothing(canvas_mcp, papers_mcp):
    canvas_mcp.board.update(goals=["new-findings", "methods"], discardedIds=["pmid:2"])
    spans = rerank_per_goal(papers_mcp)
    agent = board_master(canvas_mcp, model := ScriptedLlm(turns=master_turns()))

    events = await turn(agent, f"Find papers on {QUESTION}")

    # The master called rank_papers once and neither rerank nor set_scores, which it isn't offered.
    called = [c.name for e in events for c in e.get_function_calls()]
    assert called.count("rank_papers") == 1 and not {"rerank", "set_scores"} & set(called)
    assert not {"rerank", "set_scores"} & set(model.requests[0].tools_dict)

    # One rerank per goal, in parallel, on the placed suggestions only (pmid:11 was scored but not placed).
    reranks = [args for name, args in papers_mcp.calls if name == "rerank"]
    assert sorted(r["goal"] for r in reranks) == [f"{QUESTION}\nLooking for: methods the researcher could reuse",
                                                  f"{QUESTION}\nLooking for: new results on the question"]
    for r in reranks:
        assert r["paper_ids"] == ["pmid:14", "pmid:13", "pmid:12"] and r["k"] == 3
        assert r["seed_ids"] == ["pmid:9"] and r["exclude_ids"] == ["pmid:2"]
    (start_a, end_a), (start_b, end_b) = spans
    assert max(start_a, start_b) < min(end_a, end_b)

    # Every placed suggestion has a score for both goals; pmid:13, left out of the methods ranking, gets
    # 0.2 and low for methods only. Nothing is written for pmid:11, which isn't on the board.
    left_out = {"score": 0.2, "fit": "low", "why": "Not in the agent's top picks for this goal"}
    assert scores_by_paper(canvas_mcp) == {
        "pmid:14": {"new-findings": {"score": 0.5, "fit": "medium", "why": "Related cohort."},
                    "methods": {"score": 0.45, "fit": "medium", "why": "Similar pipeline."}},
        "pmid:13": {"new-findings": {"score": 0.9, "fit": "high", "why": "Same cells."}, "methods": left_out},
        "pmid:12": {"new-findings": {"score": 0.3, "fit": "low", "why": "Far from the question."},
                    "methods": {"score": 0.75, "fit": "high", "why": "A reusable sorting protocol."}},
    }
    # rank_papers adds no card: the one add_papers is the master's own.
    [placed] = [c for c in canvas_mcp.calls if c["tool"] == "add_papers"]
    assert [p["paperId"] for p in placed["args"]["papers"]] == ["pmid:14", "pmid:13", "pmid:12"]
    # Its writes are the turn's.
    written = {(c["runId"], c["auth"]) for c in canvas_mcp.calls if c["tool"] == "set_scores"}
    assert written == {(RUN_ID, "Bearer m_ana")}

    # The master gets each goal's placed papers, best first, with the titles the tools returned.
    [result] = [p.function_response.response for p in model.requests[5].contents[-1].parts]
    assert result["scored"] == 3 and result["skipped"] == []
    assert {goal: [(p["paperId"], p["reason"]) for p in papers] for goal, papers in result["goals"].items()} == {
        "new-findings": [("pmid:13", "Same cells."), ("pmid:14", "Related cohort."),
                         ("pmid:12", "Far from the question.")],
        "methods": [("pmid:12", "A reusable sorting protocol."), ("pmid:14", "Similar pipeline.")],
    }
    assert result["goals"]["methods"][0] == {"paperId": "pmid:12", "title": "Paper pmid:12", "year": 2024,
                                             "reason": "A reusable sorting protocol."}


async def test_a_failed_goal_ranking_leaves_that_goals_scores_alone_and_says_so(canvas_mcp, papers_mcp):
    canvas_mcp.board.update(goals=["new-findings", "methods"])
    rerank_per_goal(papers_mcp, failing="methods")
    agent = board_master(canvas_mcp, model := ScriptedLlm(turns=master_turns()))

    await turn(agent, f"Find papers on {QUESTION}")

    assert {paper: sorted(scores) for paper, scores in scores_by_paper(canvas_mcp).items()} == {
        "pmid:14": ["new-findings"], "pmid:13": ["new-findings"], "pmid:12": ["new-findings"]}
    [result] = [p.function_response.response for p in model.requests[5].contents[-1].parts]
    assert list(result["goals"]) == ["new-findings"] and result["scored"] == 3
    [skipped] = result["skipped"]
    assert skipped.startswith("Ranking for methods failed: rerank:")


def test_the_pool_is_the_placed_suggestions_only():
    state = {
        "board:b1": {"papers": ["pmid:9"], "discarded": ["pmid:2"], "seeds": ["pmid:9"], "goals": ["methods"]},
        "placed:p1": {"pmid:8": "seed", "pmid:5": "suggestion", "pmid:4": "suggestion", "pmid:2": "suggestion"},
        "scored:s1": ["pmid:4", "pmid:9", "pmid:2", "pmid:8", "pmid:7", *[f"pmid:{n}" for n in range(100, 130)]],
    }
    # Seeds (on the board or placed as seeds), discarded papers and unplaced candidates are left out.
    assert candidates.pool_for_rerank(state) == ["pmid:5", "pmid:4"]
    assert candidates.seeds(state) == ["pmid:9", "pmid:8"]


def test_note_keeps_the_boards_goals_seeds_and_question():
    board = {"question": QUESTION, "goals": ["new-findings", "methods"], "discardedIds": ["pmid:2"],
             "papers": [{"paperId": "pmid:9", "kind": "seed"}, {"paperId": "pmid:1", "kind": "suggestion"}]}
    state: dict = {}
    tool = type("Tool", (), {"name": "get_board"})()
    context = type("Context", (), {"function_call_id": "c1", "state": state})()
    candidates.note(tool=tool, args={}, tool_context=context, tool_response={"structuredContent": board})
    assert candidates.last_board(state) == {"papers": ["pmid:9", "pmid:1"], "discarded": ["pmid:2"],
                                            "seeds": ["pmid:9"], "goals": ["new-findings", "methods"],
                                            "question": QUESTION}


def test_fit_follows_the_rerank_score():
    assert ranking.fit({"score": 0.7, "reason": "x"})["fit"] == "high"
    assert ranking.fit({"score": 0.4, "reason": "x"})["fit"] == "medium"
    assert ranking.fit({"score": 0.39, "reason": "x"})["fit"] == "low"
    long = ranking.fit({"score": 0.9, "reason": "word " * 100})["why"]
    assert len(long) == 200 and long.endswith("…")
    assert ranking.fit(None) == ranking.LEFT_OUT


def test_the_board_master_ranks_with_rank_papers_and_has_no_rerank_or_set_scores():
    board = BoardTools("b_1", "m_ana", "http://board/api/mcp/canvas/b_1", {"Authorization": "Bearer m_ana"})
    agent = build_agent("master", board)
    filters = [t.tool_filter for t in agent.tools if getattr(t, "tool_filter", None)]
    assert filters == [["resolve_seed", "get_paper", "score_candidates"], ["get_board", "add_papers", "link_papers",
                                                                          "add_note", "apply_clusters",
                                                                          "label_cluster"]]
    assert sum(isinstance(t, ranking.RankPapers) for t in agent.tools) == 1
    assert "Call `rank_papers`" in agent.instruction and f"the {master.PLACE} best-scored" in agent.instruction
    assert "Don't narrate between tool calls; the plan shows your progress." in agent.instruction
    assert master.PLACE == 8 and (background.PAPERS_AT_ONCE, background.CALLS_PER_MINUTE) == (4, 40)


def test_token_factory_models_retry_twice():
    assert models.super_vl()._additional_args["num_retries"] == 2
    assert models.lightning()._additional_args["num_retries"] == 2
    assert models.super_vl()._additional_args["timeout"] == 120 and models.lightning()._additional_args["timeout"] == 45
