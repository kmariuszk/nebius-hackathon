"""Step 1 of the after-placement steps: the board's citations as `cites` links, without the model (D03)."""

from typing import Any

import test_master_board as board_tests
from conftest import ScriptedLlm, call, say
from harness.agents.master import agent as master
from test_master_board import (  # noqa: F401 (no_pacing is an autouse fixture)
    RUN_ID, Scripted, board_of, calls, no_pacing, of, place_near, turn,
)


def offer_citation_links(papers_mcp, links: list[dict[str, str]], error: str = "") -> None:
    """Give the stand-in papers MCP `citation_links`, answering `links` or failing with `error`."""

    @papers_mcp.server.tool()
    async def citation_links(paper_ids: list[str]) -> dict[str, Any]:
        papers_mcp.calls.append(("citation_links", {"paper_ids": paper_ids}))
        if error:
            raise ValueError(error)
        return {"links": links, "skipped": []}


def on_board(canvas_mcp, *paper_ids: str) -> None:
    """get_board shows these papers next to the seed pmid:9 (the stand-in's add_papers doesn't add them)."""
    canvas_mcp.board["papers"] += [{"paperId": p, "kind": "suggestion", "status": "new"} for p in paper_ids]


def cites(canvas_mcp) -> list[dict[str, Any]]:
    return [c for c in of(canvas_mcp, "link_papers") if c["args"]["links"][0]["kind"] == "cites"]


def unread(*paper_ids: str) -> Scripted:
    """Readers that fail at once, so the reading is quick and leaves a gap."""
    return Scripted(readers={p: [say("Sorry, I couldn't read it.")] for p in paper_ids}, contexts={})


async def test_a_turn_that_places_papers_links_their_citations_once_without_the_model(canvas_mcp, papers_mcp):
    offer_citation_links(papers_mcp, [{"from": "pmid:1", "to": "pmid:9", "source": "pubmed"},
                                      {"from": "pmid:3", "to": "pmid:1", "source": "openalex"}])
    on_board(canvas_mcp, "pmid:1", "pmid:3", "pmid:2")
    canvas_mcp.board["discardedIds"] = ["pmid:2"]
    passes = unread("pmid:1", "pmid:3")
    agent = master.build(board_of(canvas_mcp), reader_agent=passes.reader, context_agent=passes.context)
    agent.model = ScriptedLlm(turns=[
        calls(*[("get_paper", {"paper_id": p}) for p in ("pmid:9", "pmid:1", "pmid:3")]),
        call("add_papers", papers=[{"paperId": "pmid:9", "title": "S", "kind": "seed"},
                                   {"paperId": "pmid:1", "title": "A", "near": "pmid:9"},
                                   {"paperId": "pmid:3", "title": "B", "near": "pmid:9"}]),
        # One batch now; the turn's end starts another for pmid:3, and turns the seed's badge off.
        call("process_papers", paper_ids=["pmid:1"]),
        say("I placed them."),
    ])

    events = await turn(agent, "Place pmid:1 and pmid:3 near the seed")

    # One citation_links call for the turn, on every paper on the board but the discarded one.
    assert [args for name, args in papers_mcp.calls if name == "citation_links"] == [
        {"paper_ids": ["pmid:9", "pmid:1", "pmid:3"]}]
    [cited] = cites(canvas_mcp)
    assert cited["args"]["links"] == [{"from": "pmid:1", "to": "pmid:9", "kind": "cites", "source": "pubmed"},
                                      {"from": "pmid:3", "to": "pmid:1", "kind": "cites", "source": "openalex"}]
    assert (cited["runId"], cited["auth"], cited["model"]) == (RUN_ID, "Bearer m_ana", None)
    assert not [c for e in events for c in e.get_function_calls() if c.name == "link_papers"]
    # Before both batches' near links, and the reading still runs.
    assert [c["args"]["links"][0]["kind"] for c in of(canvas_mcp, "link_papers")] == ["cites", "similar", "similar"]
    for paper_id in ("pmid:1", "pmid:3"):
        assert of(canvas_mcp, "mark_working", paper_id)[-1]["args"]["on"] is False


async def test_citations_go_100_links_a_call_and_again_in_the_next_turn(canvas_mcp, papers_mcp, monkeypatch):
    offer_citation_links(papers_mcp, [{"from": f"pmid:{n}", "to": "pmid:9", "source": "pubmed"} for n in range(150)])
    on_board(canvas_mcp, "pmid:1", "pmid:3")
    passes = unread("pmid:1", "pmid:3")
    agent = master.build(board_of(canvas_mcp), reader_agent=passes.reader, context_agent=passes.context)

    for paper_id, run_id in (("pmid:1", RUN_ID), ("pmid:3", "run_ba9876543210")):
        monkeypatch.setattr(board_tests, "RUN_ID", run_id)  # what turn() sends
        agent.model = ScriptedLlm(turns=place_near((paper_id, "pmid:9")))
        await turn(agent, f"Place {paper_id}")

    assert [name for name, _ in papers_mcp.calls].count("citation_links") == 2
    assert [(c["runId"], len(c["args"]["links"])) for c in cites(canvas_mcp)] == [
        (RUN_ID, 100), (RUN_ID, 50), ("run_ba9876543210", 100), ("run_ba9876543210", 50)]


async def test_without_citation_links_the_step_is_hidden_and_a_failure_is_only_logged(
    canvas_mcp, papers_mcp, caplog, monkeypatch
):
    on_board(canvas_mcp, "pmid:1")
    passes = unread("pmid:1", "pmid:3")
    agent = master.build(board_of(canvas_mcp), reader_agent=passes.reader, context_agent=passes.context)
    agent.model = ScriptedLlm(turns=place_near(("pmid:1", "pmid:9")))

    await turn(agent, "Place pmid:1")

    # The papers MCP has no citation_links: the step doesn't even read the board.
    assert not of(canvas_mcp, "get_board") and not cites(canvas_mcp)
    assert of(canvas_mcp, "link_papers")[0]["args"]["links"] == [{"from": "pmid:1", "to": "pmid:9", "kind": "similar"}]

    offer_citation_links(papers_mcp, [], error="PubMed is down")
    on_board(canvas_mcp, "pmid:3")
    agent.model = ScriptedLlm(turns=place_near(("pmid:3", "pmid:9")))
    monkeypatch.setattr(board_tests, "RUN_ID", "run_ba9876543210")  # a new turn
    canvas_mcp.calls.clear()

    await turn(agent, "Place pmid:3")

    assert [r.getMessage() for r in caplog.records if r.levelname == "WARNING"
            and r.getMessage().startswith("could not link the papers that cite each other: citation_links: ")]
    # The near link and the reading still run.
    assert of(canvas_mcp, "link_papers")[0]["args"]["links"] == [{"from": "pmid:3", "to": "pmid:9", "kind": "similar"}]
    assert of(canvas_mcp, "set_card", "pmid:3") and of(canvas_mcp, "mark_working", "pmid:3")[-1]["args"]["on"] is False
