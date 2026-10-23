"""A regression test for T13's Update suggestions: the `tldraw://…/changes` resource the toolbar sends
reaches the master's model as <board-changes>, and `rank_papers` leaves out the papers discarded since
the last ranking. The model is scripted, so what it chooses to call is the live check's to test.
Against the stand-in canvas and papers MCPs."""

import json

import pytest
from acp import embedded_text_resource, resource_block, text_block
from google.adk.agents import LlmAgent
from google.adk.runners import InMemoryRunner

from conftest import ScriptedLlm, call, say
from harness.acp.mapping import to_genai_content
from harness.agents.master import agent as master
from harness.agents.master import background
from harness.agents.reader import agent as reader
from harness.board.tools import BoardTools

QUESTION = "melanoma T cells"
PLACED = ["pmid:14", "pmid:13", "pmid:12"]
# What the browser sends (client/client/pinboard/changes.ts): pmid:13 moved, pmid:12 discarded.
CHANGES = {
    "since": "2026-10-21T09:00:00.000Z",
    "changes": [
        {"type": "moved", "paperId": "pmid:13", "at": "2026-10-21T09:01:00.000Z"},
        {"type": "voted", "paperId": "pmid:12", "decision": "discard", "at": "2026-10-21T09:02:00.000Z"},
    ],
}


@pytest.fixture(autouse=True)
def no_pacing(monkeypatch):
    monkeypatch.setattr(background.PACE, "per_minute", 1000)


def unread() -> LlmAgent:
    """A reader that fails at once, so the background pass after each turn is quick."""
    agent = reader.build()
    agent.model = ScriptedLlm(turns=[say("Sorry, I couldn't read it.")])
    return agent


def update_prompt():
    """The ACP prompt the toolbar's Update suggestions sends, as the agent's message."""
    changes = embedded_text_resource("tldraw://b_test/changes", json.dumps(CHANGES), mime_type="application/json")
    return to_genai_content([text_block("Update suggestions"), resource_block(changes)])


async def test_the_changes_reach_the_model_and_the_rerank_leaves_out_papers_discarded_since(canvas_mcp, papers_mcp):
    canvas_mcp.board.update(goals=["new-findings", "methods"], question=QUESTION)
    board = BoardTools("b_test", "m_ana", canvas_mcp.url, {"Authorization": "Bearer m_ana"})
    agent = master.build(board, reader_agent=unread)
    agent.model = model = ScriptedLlm(turns=[
        # first turn: place three suggestions and rank them
        call("get_board"),
        call("score_candidates", question=QUESTION, candidate_ids=PLACED, seed_ids=["pmid:9"], limit=100),
        call("add_papers", papers=[{"paperId": p, "title": "A", "near": "pmid:9"} for p in PLACED]),
        call("rank_papers"),
        say("1. [Paper pmid:13](paper:pmid:13) (2024)."),
        # Update suggestions: look at the board first, then re-rank
        call("get_board"),
        call("rank_papers"),
        say("I re-ranked with your changes and left Paper pmid:13 where you put it."),
    ])
    runner = InMemoryRunner(agent=agent, app_name="test")
    session = await runner.session_service.create_session(app_name="test", user_id="m_ana")
    processes = next(t for t in agent.tools if isinstance(t, background.ProcessPapers))

    async def turn(message, run_id: str) -> None:
        async for _ in runner.run_async(user_id="m_ana", session_id=session.id, new_message=message,
                                        state_delta={"run_id": run_id}):
            pass
        await processes.wait()

    try:
        await turn(to_genai_content([text_block(f"Find papers on {QUESTION}")]), "run_0123456789ab")
        before = len(canvas_mcp.calls)
        reranks_before = len([c for c in papers_mcp.calls if c[0] == "rerank"])
        # what get_board says after the edits: pmid:13 moved by a person, pmid:12 discarded
        canvas_mcp.board.update(
            discardedIds=["pmid:12"],
            papers=[{"paperId": "pmid:9", "title": "Seed paper", "kind": "seed", "status": "kept"}]
            + [{"paperId": p, "title": "A", "kind": "suggestion", "status": "new", "humanTouched": p == "pmid:13"}
               for p in PLACED],
        )
        await turn(update_prompt(), "run_0123456789ac")
    finally:
        await runner.close()

    # The changes reach the model as <board-changes>, with the master's rule for them.
    first = model.requests[5]
    message = [p.text for p in first.contents[-1].parts]
    assert message == ["Update suggestions", f"<board-changes>{json.dumps(CHANGES)}</board-changes>"]
    assert "<board-changes>: call `get_board` first" in agent.instruction

    # The re-rank leaves out the paper discarded since, and every write is the new turn's.
    after = canvas_mcp.calls[before:]
    reranks = [args for name, args in papers_mcp.calls if name == "rerank"][reranks_before:]
    assert len(reranks) == 2
    for r in reranks:
        assert r["paper_ids"] == ["pmid:14", "pmid:13"] and r["exclude_ids"] == ["pmid:12"]
    assert sorted(c["args"]["paperId"] for c in after if c["tool"] == "set_scores") == ["pmid:13", "pmid:14"]
    assert {(c["runId"], c["auth"]) for c in after} == {("run_0123456789ac", "Bearer m_ana")}
