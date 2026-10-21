"""Step 4 of the after-placement steps: the board's papers in clusters, once a chat, without the model (D04)."""

from typing import Any

import test_master_board as board_tests
from conftest import ScriptedLlm, call, say
from harness.agents.master import agent as master
from mcp.server.mcpserver import Context
from test_citations_step import on_board, unread
from test_master_board import (  # noqa: F401 (no_pacing is an autouse fixture)
    RUN_ID, board_of, calls, no_pacing, of, place_near, turn,
)

CLUSTER = {"clusterId": "c-pmid_1", "label": "Tumour ecosystem", "labelGenerated": False, "humanTouched": True}


def offer_cluster_tools(canvas_mcp, error: str = "") -> None:
    """Give the stand-in canvas `apply_clusters` (answering one cluster, or failing with `error`) and `label_cluster`."""

    def record(ctx: Context, tool: str, **args: Any) -> None:
        headers = ctx.headers or {}
        canvas_mcp.calls.append({"tool": tool, "args": args, "runId": headers.get("x-run-id"),
                                 "model": headers.get("x-model"), "auth": headers.get("authorization")})

    @canvas_mcp.server.tool()
    async def apply_clusters(ctx: Context, paperIds: list[str] | None = None) -> dict[str, Any]:
        """Group the board's papers into clusters."""
        record(ctx, "apply_clusters", **({"paperIds": paperIds} if paperIds is not None else {}))
        if error:
            raise ValueError(error)
        return {"clusters": [{"clusterId": "c-pmid_1", "label": "Tumour ecosystem", "paperIds": ["pmid:1"]}],
                "skipped": []}

    @canvas_mcp.server.tool()
    async def label_cluster(clusterId: str, label: str, ctx: Context) -> dict[str, Any]:
        """Rename a cluster."""
        record(ctx, "label_cluster", clusterId=clusterId, label=label)
        return {"ok": True}


def next_turn(monkeypatch, run_id: str = "run_ba9876543210") -> None:
    monkeypatch.setattr(board_tests, "RUN_ID", run_id)  # what turn() sends


async def test_a_turn_on_a_board_of_8_papers_without_clusters_ends_with_one_apply_clusters(
    canvas_mcp, papers_mcp, monkeypatch
):
    offer_cluster_tools(canvas_mcp)
    on_board(canvas_mcp, "pmid:1", "pmid:3", "pmid:4", "pmid:5", "pmid:6", "pmid:7", "pmid:8")  # and the seed
    passes = unread("pmid:1", "pmid:3", "pmid:10")
    agent = master.build(board_of(canvas_mcp), reader_agent=passes.reader, context_agent=passes.context)
    agent.model = model = ScriptedLlm(turns=[
        calls(("get_paper", {"paper_id": "pmid:1"}), ("get_paper", {"paper_id": "pmid:3"})),
        call("add_papers", papers=[{"paperId": "pmid:1", "title": "A", "near": "pmid:9"},
                                   {"paperId": "pmid:3", "title": "B", "near": "pmid:9"}]),
        call("rank_papers"),
        say("1. [Single-cell melanoma atlas](paper:pmid:1) (2024). Same cells."),
    ])

    events = await turn(agent, "Find papers on melanoma T cells")

    # The master may rename clusters, and the step clusters for it, with every paper on the board.
    assert {"apply_clusters", "label_cluster"} <= set(model.requests[0].tools_dict)
    assert not [c for e in events for c in e.get_function_calls() if c.name == "apply_clusters"]
    [clustered] = of(canvas_mcp, "apply_clusters")
    assert clustered["args"] == {}
    assert (clustered["runId"], clustered["auth"], clustered["model"]) == (RUN_ID, "Bearer m_ana", None)
    # After rank_papers wrote the fits.
    assert canvas_mcp.calls.index(clustered) > canvas_mcp.calls.index(of(canvas_mcp, "set_scores")[-1])
    assert "never re-cluster a board that has clusters" in agent.instruction

    # Once a chat: the next turn doesn't even look.
    canvas_mcp.calls.clear()
    next_turn(monkeypatch)
    agent.model = ScriptedLlm(turns=place_near(("pmid:10", "pmid:1")))
    await turn(agent, "One more like pmid:1")
    assert not of(canvas_mcp, "apply_clusters") and not of(canvas_mcp, "get_board")


async def test_a_board_that_has_a_cluster_is_left_as_it_is(canvas_mcp, papers_mcp, monkeypatch):
    offer_cluster_tools(canvas_mcp)
    on_board(canvas_mcp, "pmid:1", "pmid:3", "pmid:4", "pmid:5", "pmid:6", "pmid:7", "pmid:8")
    canvas_mcp.board["clusters"] = [CLUSTER]  # a person's
    passes = unread("pmid:1", "pmid:3", "pmid:10")
    agent = master.build(board_of(canvas_mcp), reader_agent=passes.reader, context_agent=passes.context)
    agent.model = ScriptedLlm(turns=place_near(("pmid:1", "pmid:9"), ("pmid:3", "pmid:9")))

    await turn(agent, "Place pmid:1 and pmid:3")

    assert not of(canvas_mcp, "apply_clusters") and len(of(canvas_mcp, "get_board")) == 1
    next_turn(monkeypatch)
    agent.model = ScriptedLlm(turns=place_near(("pmid:10", "pmid:1")))
    await turn(agent, "One more")
    assert not of(canvas_mcp, "apply_clusters") and len(of(canvas_mcp, "get_board")) == 1


async def test_a_board_under_6_papers_is_clustered_once_it_has_6(canvas_mcp, papers_mcp, monkeypatch):
    offer_cluster_tools(canvas_mcp)
    on_board(canvas_mcp, "pmid:1", "pmid:3", "pmid:4", "pmid:5")
    passes = unread("pmid:1", "pmid:3", "pmid:6")
    agent = master.build(board_of(canvas_mcp), reader_agent=passes.reader, context_agent=passes.context)
    agent.model = ScriptedLlm(turns=place_near(("pmid:1", "pmid:9"), ("pmid:3", "pmid:9")))

    await turn(agent, "Place pmid:1 and pmid:3")
    assert not of(canvas_mcp, "apply_clusters")

    on_board(canvas_mcp, "pmid:6")
    next_turn(monkeypatch)
    agent.model = ScriptedLlm(turns=place_near(("pmid:6", "pmid:1")))
    await turn(agent, "One more")
    assert [c["runId"] for c in of(canvas_mcp, "apply_clusters")] == ["run_ba9876543210"]


async def test_without_apply_clusters_the_step_is_hidden_and_a_failure_is_only_logged(
    canvas_mcp, papers_mcp, caplog, monkeypatch
):
    on_board(canvas_mcp, "pmid:1", "pmid:3", "pmid:4", "pmid:5", "pmid:6", "pmid:7", "pmid:8")
    passes = unread("pmid:1", "pmid:3", "pmid:10")
    agent = master.build(board_of(canvas_mcp), reader_agent=passes.reader, context_agent=passes.context)
    agent.model = ScriptedLlm(turns=place_near(("pmid:1", "pmid:9")))

    await turn(agent, "Place pmid:1")

    # The canvas has no apply_clusters (the papers MCP has no cluster_papers): the step doesn't read the board.
    assert not of(canvas_mcp, "get_board")

    offer_cluster_tools(canvas_mcp, error="The papers MCP couldn't cluster the papers; nothing was written")
    for paper_id, run_id in (("pmid:3", "run_ba9876543210"), ("pmid:10", "run_cba987654321")):
        next_turn(monkeypatch, run_id)
        agent.model = ScriptedLlm(turns=place_near((paper_id, "pmid:9")))
        await turn(agent, f"Place {paper_id}")

    assert [r.getMessage() for r in caplog.records if r.levelname == "WARNING"
            and r.getMessage().startswith("could not cluster the board's papers: apply_clusters: ")]
    # Nothing was clustered, so the next turn tries again; the reading still runs.
    assert [c["runId"] for c in of(canvas_mcp, "apply_clusters")] == ["run_ba9876543210", "run_cba987654321"]
    assert of(canvas_mcp, "mark_working", "pmid:10")[-1]["args"]["on"] is False
