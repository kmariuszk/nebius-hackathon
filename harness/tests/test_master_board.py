"""The master on a board: scoring, placing, reading in the background and ranking, against the
stand-in canvas and papers MCPs."""

import json
import re

import pytest
from google.adk.agents import LlmAgent
from google.adk.models.llm_request import LlmRequest
from google.adk.runners import InMemoryRunner
from google.genai import types

from conftest import ScriptedLlm, call, say
from harness.acp.adapter import build_agent
from harness.agents.context import agent as context
from harness.agents.master import agent as master
from harness.agents.master import background
from harness.agents.reader import agent as reader
from harness.agents.search import agent as search
from harness.board.tools import BoardTools

RUN_ID = "run_0123456789ab"
ABSTRACT = "We profiled 40,000 T cells from 12 melanomas."
GLANCE = [
    {"label": "Samples", "text": "12 melanomas", "quoteId": "q1", "relation": "same"},
    {"label": "Method", "text": "Single-cell profiling", "quoteId": None, "relation": "adds"},
    {"label": "Finding", "text": "TOX marks exhausted clones", "quoteId": None, "relation": None},
]


class PerPaper(ScriptedLlm):
    """A ScriptedLlm that replays the turns scripted for the paper its request names ("Paper ID: …")."""

    turns: list[types.Content] = []
    scripts: dict[str, list[types.Content]]

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False):
        if not self.requests:
            self.turns = self.scripts[re.search(r"Paper ID: (\S+)", text_of(llm_request)).group(1)]
        async for response in super().generate_content_async(llm_request, stream):
            yield response


def text_of(llm_request: LlmRequest) -> str:
    return " ".join(p.text or "" for c in llm_request.contents for p in c.parts or [])


def calls(*pairs: tuple[str, dict]) -> types.Content:
    """One model turn with several function calls, which ADK runs in parallel."""
    parts = [types.Part(function_call=types.FunctionCall(name=name, args=args)) for name, args in pairs]
    return types.Content(role="model", parts=parts)


def reading(paper_id: str) -> dict:
    return {
        "paperId": paper_id, "source": "pmc", "tldr": "TOX marks exhausted T cell clones in melanoma.",
        "summary": "They profiled 40,000 T cells from 12 melanomas.", "rewrittenAbstract": "…",
        "highlights": [{"text": ABSTRACT, "section": "Abstract", "category": "dataset", "note": "The cohort."}],
        "quotes": [{"text": "TOX marked every exhausted clone.", "section": "Results", "link": "https://pmc/PMC1/"}],
        "figures": [], "notes": "",
    }


def reader_turns(paper_id: str) -> list[types.Content]:
    return [
        call("get_fulltext", paper_id=paper_id),
        call("check_quotes", paper_id=paper_id, quotes=["TOX marked every exhausted clone.", ABSTRACT]),
        say(json.dumps(reading(paper_id))),
    ]


def context_turns(paper_id: str) -> list[types.Content]:
    one_line = "Profiles the same exhausted T cells as your seed, in 12 melanomas."
    card = call("set_card", paperId=paper_id, oneLine=one_line, glance=GLANCE,
                claims=[{"text": "exhausted T cells", "evidence": ["q1"]}])
    link = call("link_papers", links=[{"from": paper_id, "to": "pmid:9", "kind": "similar"}])
    return [call("get_board"), calls(*[(p.function_call.name, p.function_call.args) for p in card.parts + link.parts]),
            say("Linked it to the seed.")]


class Scripted:
    """Factories for the background agents, each built with its paper's script; `built` keeps them."""

    def __init__(self, readers: dict[str, list[types.Content]], contexts: dict[str, list[types.Content]]):
        self.readers, self.contexts = readers, contexts
        self.built: list[LlmAgent] = []

    def reader(self) -> LlmAgent:
        return self.keep(reader.build(), self.readers)

    def context(self, board: BoardTools) -> LlmAgent:
        return self.keep(context.build(board), self.contexts)

    def keep(self, agent: LlmAgent, scripts: dict[str, list[types.Content]]) -> LlmAgent:
        agent.model = PerPaper(scripts=scripts)
        self.built.append(agent)
        return agent


def scripted_search(query: str, seeds: list[str] | None = None) -> LlmAgent:
    turns = [call("search", query=query)]
    if seeds:
        turns.append(call("find_candidates", seed_ids=seeds))
    turns.append(call("done", sub_query=query, candidates=[], seed_candidates=len(seeds or []), notes=""))
    agent = search.build()
    agent.model = ScriptedLlm(turns=turns)
    return agent


def board_of(canvas) -> BoardTools:
    return BoardTools("b_test", "m_ana", canvas.url, {"Authorization": "Bearer m_ana"})


async def turn(agent: LlmAgent, text: str) -> list:
    """One prompt turn with the run ID the ACP worker would set; waits for the background passes too."""
    runner = InMemoryRunner(agent=agent, app_name="test")
    session = await runner.session_service.create_session(app_name="test", user_id="m_ana")
    message = types.Content(role="user", parts=[types.Part(text=text)])
    try:
        events = [
            e async for e in runner.run_async(
                user_id="m_ana", session_id=session.id, new_message=message, state_delta={"run_id": RUN_ID}
            )
        ]
        return events
    finally:
        await processes(agent).wait()
        await runner.close()


def processes(agent: LlmAgent) -> background.ProcessPapers:
    return next(t for t in agent.tools if isinstance(t, background.ProcessPapers))


def of(canvas, tool: str, paper_id: str | None = None) -> list[dict]:
    return [
        c for c in canvas.calls
        if c["tool"] == tool and paper_id in (None, c["args"].get("paperId"), *(c["args"].get("paperIds") or []))
    ]


@pytest.fixture(autouse=True)
def no_pacing(monkeypatch):
    monkeypatch.setattr(background, "PACE", background.Pace(1000))


async def test_master_places_scored_papers_reads_them_in_the_background_and_ranks_them(canvas_mcp, papers_mcp):
    canvas_mcp.board.update(goals=["new-findings", "methods"], discardedIds=["pmid:2"])
    canvas_mcp.abstract = ABSTRACT
    papers_mcp.fulltext_delay = 0.5  # reading outlasts the master's turn
    scripts = iter([
        search.build,  # the template SearchTool builds once for its declaration
        lambda: scripted_search("melanoma T cells", seeds=["pmid:9"]),
        lambda: scripted_search("spatial exhaustion"),
    ])
    passes = Scripted(
        readers={p: reader_turns(p) for p in ("pmid:1", "pmid:3")},
        contexts={p: context_turns(p) for p in ("pmid:1", "pmid:3")},
    )
    scores = {"new-findings": {"score": 0.8, "fit": "high", "why": "Same cells."},
              "methods": {"score": 0.4, "fit": "medium", "why": "Single-cell profiling."}}
    board = board_of(canvas_mcp)
    # The adapter names each agent's Nemotron model for X-Model before the chat starts.
    board.models.update(reader="nvidia/Nemotron-3.5-Super-VL", context="nvidia/Nemotron-3_5-Lightning")
    agent = master.build(board, search_agent=lambda: next(scripts)(),
                         reader_agent=passes.reader, context_agent=passes.context)
    agent.model = model = ScriptedLlm(turns=[
        calls(("get_board", {}), ("update_plan", {"entries": [{"content": "Search", "status": "in_progress"}]})),
        calls(("search", {"request": "Sub-query: melanoma T cells. Seed paper IDs: pmid:9"}),
              ("search", {"request": "Sub-query: spatial exhaustion. Exclude: pmid:2"})),
        # The model copies IDs wrong; the pool replaces them.
        call("score_candidates", question="melanoma T cells", candidate_ids=["pmid:mangled"], seed_ids=["pmid:9"],
             limit=100),
        call("add_papers", papers=[
            {"paperId": "pmid:3", "title": "Spatial atlas (retyped)", "near": "pmid:9"},
            {"paperId": "pmid:1", "title": "Single-cell atlas", "near": "pmid:9"},
            {"paperId": "pmid:404", "title": "A paper no tool returned", "near": "pmid:9"},
        ]),
        call("process_papers", paper_ids=[]),
        call("rerank", goal="melanoma T cells", paper_ids=["pmid:1"], seed_ids=["pmid:9"], k=12),
        calls(("set_scores", {"paperId": "pmid:1", "scores": scores}),
              ("set_scores", {"paperId": "pmid:3", "scores": scores})),
        say("1. [Single-cell melanoma atlas](paper:pmid:1) (2024). Same cells."),
    ])

    events = await turn(agent, "Find papers on melanoma T cells. Seed: pmid:9")

    tools = sorted(model.requests[0].tools_dict)
    assert tools == ["add_note", "add_papers", "get_board", "get_paper", "link_papers", "process_papers", "reader",
                     "rerank", "resolve_seed", "score_candidates", "search", "set_scores", "update_plan"]
    assert events[-1].content.parts[0].text.startswith("1. [Single-cell melanoma atlas](paper:pmid:1)")

    # score_candidates gets the pool without the discarded pmid:2; rerank gets the scored order.
    by_tool = {name: args for name, args in papers_mcp.calls if name in {"score_candidates", "rerank"}}
    assert sorted(by_tool["score_candidates"]["candidate_ids"]) == ["pmid:1", "pmid:3"]
    assert by_tool["rerank"]["paper_ids"] == ["pmid:3", "pmid:1"]
    assert by_tool["rerank"]["exclude_ids"] == ["pmid:2"]

    # Cards: the invented paper is dropped, titles come from the tools, and nobody sends coordinates.
    [placed] = of(canvas_mcp, "add_papers")
    assert placed["args"]["papers"] == [
        {"paperId": "pmid:3", "title": "Single-cell melanoma atlas", "near": "pmid:9", "foundBy": ["pubmed"],
         "year": 2024},
        {"paperId": "pmid:1", "title": "Single-cell melanoma atlas", "near": "pmid:9", "foundBy": ["pubmed"],
         "year": 2024},
    ]
    assert not [c for c in canvas_mcp.calls if {"x", "y"} & set(c["args"]) or any(
        {"x", "y"} & set(p) for p in c["args"].get("papers", []))]
    assert [c["args"]["paperId"] for c in of(canvas_mcp, "set_scores")] == ["pmid:1", "pmid:3"]

    # The master's turn ends before the background passes do.
    assert model.requests[-1].contents[-1].parts[0].function_response.name == "set_scores"
    first_card = next(i for i, c in enumerate(canvas_mcp.calls) if c["tool"] == "set_card")
    assert first_card > canvas_mcp.calls.index(of(canvas_mcp, "set_scores")[-1])

    for paper_id in ("pmid:1", "pmid:3"):
        steps = [(c["tool"], c["args"].get("on")) for c in canvas_mcp.calls
                 if c["tool"] in {"mark_working", "add_quote", "set_card"}
                 and paper_id in (c["args"].get("paperId"), *(c["args"].get("paperIds") or []))]
        # Badge on, the reader's quotes and summary, the context agent's card, badge off.
        assert steps[0] == ("mark_working", True) and steps[-1] == ("mark_working", False)
        quotes = [c["args"]["text"] for c in of(canvas_mcp, "add_quote", paper_id)]
        assert quotes == ["TOX marked every exhausted clone.", ABSTRACT]  # only the abstract one is kept
        summary, card = of(canvas_mcp, "set_card", paper_id)
        assert summary["args"] == {"paperId": paper_id, "summary": "They profiled 40,000 T cells from 12 melanomas."}
        # The reader's artifacts are written under its model, the context agent's under its own.
        assert summary["model"] == "nvidia/Nemotron-3.5-Super-VL"
        assert card["args"]["glance"] == GLANCE and card["model"] == "nvidia/Nemotron-3_5-Lightning"
        assert [link["args"]["links"] for link in of(canvas_mcp, "link_papers")
                if link["args"]["links"][0]["from"] == paper_id] == [[{"from": paper_id, "to": "pmid:9",
                                                                      "kind": "similar"}]]

    # The context agent sees the card's quote IDs, the abstract and the reader's findings.
    contexts = [a for a in passes.built if a.name == "context"]
    request = text_of(contexts[0].model.requests[0])
    assert "q1: " + ABSTRACT in request and "TOX marks exhausted T cell clones" in request
    assert "The researcher's question: melanoma T cells" in request

    # Every write, from the turn or the background, is the turn's: same run and member.
    assert {(c["runId"], c["auth"]) for c in canvas_mcp.calls} == {(RUN_ID, "Bearer m_ana")}


async def test_failed_passes_clear_the_badge_and_say_why(canvas_mcp, papers_mcp):
    canvas_mcp.abstract = ABSTRACT
    passes = Scripted(
        readers={"pmid:1": [say("Sorry, I couldn't read it.")], "pmid:3": reader_turns("pmid:3")},
        contexts={"pmid:3": [call("get_board")]},  # then runs out of turns
    )
    agent = master.build(board_of(canvas_mcp), reader_agent=passes.reader, context_agent=passes.context)
    agent.model = ScriptedLlm(turns=[
        calls(("get_paper", {"paper_id": "pmid:1"}), ("get_paper", {"paper_id": "pmid:3"})),
        call("add_papers", papers=[{"paperId": "pmid:1", "title": "A", "near": "pmid:9"},
                                   {"paperId": "pmid:3", "title": "B", "near": "pmid:9"}]),
        # It never calls process_papers; the papers are read anyway once the turn ends.
        say("I placed two papers."),
    ])

    await turn(agent, "Place pmid:1 and pmid:3")

    for paper_id in ("pmid:1", "pmid:3"):
        assert of(canvas_mcp, "mark_working", paper_id)[-1]["args"]["on"] is False
    [unread] = of(canvas_mcp, "set_card", "pmid:1")
    assert unread["args"]["gaps"] == ["The agent couldn't read this paper: the reader's answer wasn't the JSON it should be"]
    summary, gaps = of(canvas_mcp, "set_card", "pmid:3")
    assert summary["args"]["summary"]  # the reader's part stays
    assert gaps["args"]["gaps"][0].startswith("The agent couldn't relate this paper to the board:")


async def test_process_papers_reads_only_papers_placed_in_this_chat(canvas_mcp, papers_mcp):
    canvas_mcp.abstract = ABSTRACT
    passes = Scripted(readers={"pmid:1": reader_turns("pmid:1")}, contexts={"pmid:1": context_turns("pmid:1")})
    agent = master.build(board_of(canvas_mcp), reader_agent=passes.reader, context_agent=passes.context)
    agent.model = model = ScriptedLlm(turns=[
        call("get_paper", paper_id="pmid:1"),
        call("add_papers", papers=[{"paperId": "pmid:1", "title": "A", "near": "pmid:9"}]),
        call("process_papers", paper_ids=["pmid:1", "pmid:9", "pmid:1"]),
        call("process_papers", paper_ids=[]),
        say("Reading."),
    ])

    await turn(agent, "Place and read pmid:1")

    first, again = [p.function_response.response for r in model.requests[3:5] for p in r.contents[-1].parts]
    assert first == {"started": ["pmid:1"], "alreadyStarted": [], "notPlaced": ["pmid:9"]}
    assert again == {"started": [], "alreadyStarted": ["pmid:1"], "notPlaced": []}
    assert [c["args"]["on"] for c in of(canvas_mcp, "mark_working", "pmid:1")] == [True, False]


async def test_pace_holds_back_calls_past_the_limit(monkeypatch):
    now = [0.0]
    slept: list[float] = []

    async def sleep(seconds: float) -> None:
        slept.append(seconds)
        now[0] += seconds

    monkeypatch.setattr(background.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(background.asyncio, "sleep", sleep)
    pace = background.Pace(2)
    for _ in range(3):
        await pace.before_model(None, None)
    assert slept == [60.0]


def test_without_a_board_the_master_is_unchanged():
    agent = master.build()
    assert [type(t).__name__ for t in agent.tools] == ["SearchTool", "AgentTool", "McpToolset"]
    assert agent.tools[2].tool_filter == ["resolve_seed", "get_paper", "rerank"]
    assert agent.instruction == master.INSTRUCTION and agent.after_agent_callback is None
    assert agent.before_tool_callback is master.candidates.fill_rerank


def test_the_acp_adapter_builds_the_master_with_the_chats_board():
    board = BoardTools("b_1", "m_ana", "http://board/api/mcp/canvas/b_1", {"Authorization": "Bearer m_ana"})
    agent = build_agent("master", board)
    filters = [t.tool_filter for t in agent.tools if hasattr(t, "tool_filter") and t.tool_filter]
    assert ["get_board", "add_papers", "set_scores", "link_papers", "add_note"] in filters
    assert processes(agent).board is board
    assert agent.instruction == master.BOARD_INSTRUCTION
    assert context.build(board).model.model == "openai/nvidia/Nemotron-3_5-Lightning"
