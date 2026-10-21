"""The reader's figure pick onto the card (D05), against the stand-in canvas and papers MCPs."""

import json
from types import SimpleNamespace
from typing import Any

import pytest
from google.adk.agents import LlmAgent

from conftest import ScriptedLlm, call, say
from harness.agents.context import agent as context
from harness.agents.master import background
from harness.agents.reader import agent as reader
from harness.board.tools import BoardTools

PAPER = "pmid:1"
URL = "https://cdn.ncbi.nlm.nih.gov/pmc/blobs/c11f/4944528/48328c626293/nihms791837f2.jpg"
CAPTION = "(A) Cell cycle state of individual malignant cells by G1/S and G2/M gene sets. " * 25  # over 1,500
FIGURES = [
    {"figureId": "F1", "label": "Figure 1", "caption": "Overview of workflow.", "imageUrl": None},
    {"figureId": "F2", "label": "Figure 2", "caption": CAPTION, "imageUrl": URL},
]
GLANCE = [{"label": "Samples", "text": "19 melanomas", "quoteId": None, "relation": "same"}] * 3


@pytest.fixture(autouse=True)
def no_pacing(monkeypatch):
    monkeypatch.setattr(background.PACE, "per_minute", 1000)


@pytest.fixture
def get_figures(papers_mcp):
    """`get_figures` on the stand-in papers MCP: F1 without an image, F2 with one; `fail` makes it fail."""
    state = SimpleNamespace(fail=False)

    @papers_mcp.server.tool()
    async def get_figures(paper_id: str) -> dict[str, Any]:
        papers_mcp.calls.append(("get_figures", {"paper_id": paper_id}))
        if state.fail:
            raise ValueError("PMC is down")
        return {"paperId": paper_id, "source": "pmc", "figures": FIGURES, "skipped": []}

    return state


async def read(canvas, picks: list[str]) -> None:
    """One background pass over PAPER: the reader picks these figures, the context agent fills in the card."""
    reading = {"paperId": PAPER, "source": "pmc", "summary": "They profiled 4,645 cells from 19 melanomas.",
               "quotes": [], "highlights": [], "figures": [{"figureId": f, "label": "", "why": "…"} for f in picks]}

    def reader_agent() -> LlmAgent:
        agent = reader.build()
        agent.model = ScriptedLlm(turns=[say(json.dumps(reading))])
        return agent

    def context_agent(board: BoardTools) -> LlmAgent:
        agent = context.build(board)
        agent.model = ScriptedLlm(turns=[
            call("set_card", paperId=PAPER, oneLine="Profiles the same cells as your seed.", glance=GLANCE),
            say("Done."),
        ])
        return agent

    board = BoardTools("b_test", "m_ana", canvas.url, {"Authorization": "Bearer m_ana"})
    await background.ProcessPapers(board, reader_agent, context_agent).read_then_relate(
        background.Job(PAPER, "run_0123456789ab", "melanoma"))


def card_writes(canvas) -> list[dict[str, Any]]:
    return [{k: v for k, v in c["args"].items() if k != "paperId"} for c in canvas.calls if c["tool"] == "set_card"]


async def test_the_readers_first_pick_with_an_image_goes_on_the_card(canvas_mcp, papers_mcp, get_figures):
    await read(canvas_mcp, ["F9", "F1", "F2"])  # F9 isn't listed, F1 has no image

    assert ("get_figures", {"paper_id": PAPER}) in papers_mcp.calls
    summary, figure, why = card_writes(canvas_mcp)
    assert summary == {"summary": "They profiled 4,645 cells from 19 melanomas."}
    assert figure == {"figure": {"imageUrl": URL, "label": "Figure 2", "caption": CAPTION[:1500], "captionByAi": False}}
    assert why["oneLine"] and "gaps" not in why


async def test_a_pick_without_an_image_writes_no_figure(canvas_mcp, papers_mcp, get_figures):
    await read(canvas_mcp, ["F1"])

    assert ("get_figures", {"paper_id": PAPER}) in papers_mcp.calls
    assert [sorted(w) for w in card_writes(canvas_mcp)] == [["summary"], ["glance", "oneLine"]]


async def test_no_pick_no_figure_lookup(canvas_mcp, papers_mcp, get_figures):
    await read(canvas_mcp, [])

    assert "get_figures" not in [name for name, _ in papers_mcp.calls]
    assert [sorted(w) for w in card_writes(canvas_mcp)] == [["summary"], ["glance", "oneLine"]]


async def test_a_failed_figure_lookup_is_logged_and_never_a_gap(canvas_mcp, papers_mcp, get_figures, caplog):
    get_figures.fail = True

    await read(canvas_mcp, ["F2"])

    assert f"background {PAPER} reader get_figures: Error executing tool get_figures" in [
        r.getMessage() for r in caplog.records if r.levelname == "WARNING"]
    assert [sorted(w) for w in card_writes(canvas_mcp)] == [["summary"], ["glance", "oneLine"]]
    assert [c["args"]["on"] for c in canvas_mcp.calls if c["tool"] == "mark_working"] == [False]
