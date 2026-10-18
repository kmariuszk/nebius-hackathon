"""`python -m harness` as a real subprocess with scripted models and stand-in canvas and papers MCPs.

Covers T04's acceptance criteria 2 to 5: the order of updates (with a card from
inside the search sub-agent), run IDs per prompt, cancel during a slow tool, and
a tool that prints.
"""

import asyncio
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from acp import text_block

from fixtures.acp_client import harness

TESTS = Path(__file__).parent
SUPER_VL = "nvidia/Nemotron-3.5-Super-VL"
LIGHTNING = "nvidia/Nemotron-3_5-Lightning"
PLAN = [
    {"content": "Search for papers", "status": "in_progress", "priority": "high"},
    {"content": "Add the best ones to the board", "status": "pending"},
]
CANDIDATE = {"paper_id": "pmid:1", "title": "Single-cell melanoma atlas", "found_by": ["pubmed"], "why": "atlas"}
INVENTED = {"paper_id": "PMID:34512345", "title": "A paper no tool returned", "found_by": ["pubmed"], "why": "made up"}
ANSWER = "I added [Single-cell melanoma atlas](paper:pmid:1) to the board."


def call(name: str, **args) -> dict:
    return {"calls": [{"name": name, "args": args}]}


def scripted(tmp_path: Path, agent: str = "board_assistant", **turns) -> dict[str, str]:
    path = tmp_path / "script.json"
    path.write_text(json.dumps(turns))
    # No real key: a scripted run must never reach Token Factory.
    return {"HARNESS_MODEL": f"scripted:{path}", "HARNESS_AGENT": agent, "TF_API_KEY": "", "PYTHONPATH": str(TESTS)}


def first(updates: list, predicate) -> int:
    return next(i for i, u in enumerate(updates) if predicate(u))


def card(title: str):
    return lambda u: u.session_update == "tool_call" and u.title == title


async def test_a_prompt_streams_the_plan_cards_from_sub_agents_and_the_answer(canvas_mcp, papers_mcp, tmp_path):
    env = scripted(
        tmp_path,
        board_assistant=[
            call("update_plan", entries=PLAN),
            call("get_board"),
            call("search", request="exhausted CD8 T cells in melanoma"),
            call("add_papers", papers=[{"paperId": "pmid:1", "title": "Single-cell melanoma atlas"}], near="pmid:9"),
            {"thought": "The atlas fits the question.", "text": ANSWER},
            call("add_note", text="The CD8 cluster needs a review", paperId="pmid:1"),
            {"text": "Noted."},
        ],
        search=[
            call("search", query="exhausted CD8 T cells in melanoma", limit=10),
            call(
                "done", sub_query="exhausted CD8 T cells", candidates=[CANDIDATE, INVENTED], seed_candidates=0, notes=""
            ),
        ],
    )
    async with harness(env=env) as h:
        session = await h.start(canvas_mcp.url, member="m_ana")
        result = await h.conn.prompt(session_id=session, prompt=[text_block("Find papers on exhausted CD8 T cells")])
        turn = list(h.client.updates)
        again = await h.conn.prompt(session_id=session, prompt=[text_block("Note that the CD8 cluster needs a review")])

    assert result.stop_reason == again.stop_reason == "end_turn"

    # Criterion 2: plan, a card from inside the search sub-agent, add_papers, then the answer.
    plan = first(turn, lambda u: u.session_update == "plan")
    inner = first(turn, card("search: search"))
    add = first(turn, card("board_assistant: add_papers"))
    answer = first(turn, lambda u: u.session_update == "agent_message_chunk")
    assert plan < inner < add < answer
    assert [(e.content, e.status, e.priority) for e in turn[plan].entries] == [
        ("Search for papers", "in_progress", "high"),
        ("Add the best ones to the board", "pending", "medium"),
    ]
    titles = [u.title for u in turn if u.session_update == "tool_call"]
    assert titles == [
        "board_assistant: get_board",
        "board_assistant: search",
        "search: search",
        "search: done",
        "board_assistant: add_papers",
    ]
    # Partial chunks and the final event carry the same text; it arrives once.
    assert "".join(u.content.text for u in turn if u.session_update == "agent_message_chunk") == ANSWER
    assert "".join(u.content.text for u in turn if u.session_update == "agent_thought_chunk") == "The atlas fits the question."

    starts = {u.tool_call_id: u for u in turn if u.session_update == "tool_call"}
    ends = {u.tool_call_id: u for u in turn if u.session_update == "tool_call_update"}
    assert starts.keys() == ends.keys()
    assert {u.status for u in ends.values()} == {"completed"}
    by_title = {u.title: u for u in starts.values()}
    assert by_title["search: search"].kind == "search"
    assert by_title["board_assistant: search"].kind == "think"
    assert by_title["board_assistant: add_papers"].kind == "edit"
    assert by_title["board_assistant: get_board"].kind == "read"
    assert by_title["search: search"].field_meta["model"] == LIGHTNING
    assert by_title["board_assistant: add_papers"].field_meta["model"] == SUPER_VL
    # The search agent's card carries the cost of both of its model calls.
    sub_agent = ends[by_title["board_assistant: search"].tool_call_id].field_meta
    assert sub_agent["tokens"] == 2 * (1200 + 80) and sub_agent["costUsd"] > 0
    # board_assistant gets the answer `done` accepted, not the empty text of a run that ends in a tool call,
    # and only with papers a tool returned.
    found = ends[by_title["board_assistant: search"].tool_call_id].raw_output
    assert [c["paperId"] for c in found["candidates"]] == ["pmid:1"]
    assert found["notes"] == "dropped 1 paper no tool returned: PMID:34512345"
    assert ends[by_title["board_assistant: add_papers"].tool_call_id].field_meta["tokens"] == 0
    assert turn[-1].session_update == "usage_update" and turn[-1].cost.amount > 0

    # Criterion 3: one run ID per prompt on every canvas call, with the caller's model and member.
    assert canvas_mcp.tools_called() == ["get_board", "add_papers", "add_note"]
    run_ids = [c["runId"] for c in canvas_mcp.calls]
    assert all(re.fullmatch(r"run_[0-9a-f]{12}", r) for r in run_ids)
    assert run_ids[0] == run_ids[1] != run_ids[2]
    assert by_title["board_assistant: add_papers"].field_meta["runId"] == run_ids[0]
    assert {c["model"] for c in canvas_mcp.calls} == {SUPER_VL}
    assert {c["auth"] for c in canvas_mcp.calls} == {"Bearer m_ana"}
    assert canvas_mcp.calls[1]["args"]["near"] == "pmid:9"
    assert papers_mcp.calls == [("search", {"query": "exhausted CD8 T cells in melanoma", "limit": 10})]
    assert h.client.text().endswith("Noted.")
    h.stdout_messages()


async def test_cancel_during_a_slow_tool_returns_cancelled_quickly(canvas_mcp, tmp_path):
    canvas_mcp.delay = 30
    env = scripted(tmp_path, board_assistant=[call("get_board"), {"text": "Still here."}])
    async with harness(env=env) as h:
        session = await h.start(canvas_mcp.url)
        turn = asyncio.create_task(h.conn.prompt(session_id=session, prompt=[text_block("What's on the board?")]))
        started = await h.client.wait_for(card("board_assistant: get_board"))
        async with asyncio.timeout(10):
            while not canvas_mcp.calls:  # the MCP call is in flight
                await asyncio.sleep(0.05)
        clock = asyncio.get_running_loop().time()
        await h.conn.cancel(session_id=session)
        result = await asyncio.wait_for(turn, 2)
        elapsed = asyncio.get_running_loop().time() - clock

        assert result.stop_reason == "cancelled"
        assert elapsed < 2
        update = next(
            u for u in h.client.updates
            if u.session_update == "tool_call_update" and u.tool_call_id == started.tool_call_id
        )
        assert update.status == "failed" and update.content[0].content.text == "cancelled"

        # The chat goes on after a cancel.
        canvas_mcp.delay = 0
        again = await h.conn.prompt(session_id=session, prompt=[text_block("Are you there?")])
        assert again.stop_reason == "end_turn"
        assert h.client.text() == "Still here."
    assert "cancel scope" not in h.stderr_text()


@pytest.mark.parametrize("how", ["stdin", "sigterm"])
async def test_the_process_exits_within_3_seconds_mid_turn(canvas_mcp, tmp_path, how):
    canvas_mcp.delay = 30
    env = scripted(tmp_path, board_assistant=[call("get_board")])
    async with harness(env=env) as h:
        session = await h.start(canvas_mcp.url)
        asyncio.create_task(h.conn.prompt(session_id=session, prompt=[text_block("What's on the board?")]))
        await h.client.wait_for(card("board_assistant: get_board"))
        assert await h.stop(how) < 3
        assert h.process.returncode == 0
    assert "cancel scope" not in h.stderr_text()


async def test_a_tool_that_prints_does_not_corrupt_stdout(canvas_mcp, tmp_path):
    env = scripted(
        tmp_path,
        agent="fixtures.agents:loud",
        board_assistant=[call("shout", text="hello from a tool"), call("get_board"), {"text": "Done."}],
    )
    # The browser sends its own origin; the harness reaches the board service at BOARD_INTERNAL_URL.
    internal = urlsplit(canvas_mcp.url)
    env["BOARD_INTERNAL_URL"] = f"http://{internal.netloc}"
    async with harness(env=env) as h:
        session = await h.start(f"http://board.example:5173{internal.path}")
        result = await h.conn.prompt(session_id=session, prompt=[text_block("Say hello")])

    assert result.stop_reason == "end_turn"
    assert h.client.text() == "Done."
    messages = h.stdout_messages()  # every stdout line parses as JSON
    assert all(m["jsonrpc"] == "2.0" for m in messages)
    assert "hello from a tool\n" in h.stderr_text() and "hello from a tool (fd 1)" in h.stderr_text()
    assert canvas_mcp.tools_called() == ["get_board"]


async def test_without_a_canvas_the_agent_just_has_no_canvas_tools(papers_mcp, tmp_path):
    env = scripted(tmp_path, board_assistant=[{"text": "No board here."}])
    async with harness(env=env) as h:
        session = await h.start()
        result = await h.conn.prompt(session_id=session, prompt=[text_block("Hi")])
        assert result.stop_reason == "end_turn"
        assert h.client.text() == "No board here."


async def test_a_missing_key_fails_session_new_with_the_fix(tmp_path):
    async with harness(env={"HARNESS_AGENT": "board_assistant", "HARNESS_MODEL": "", "TF_API_KEY": ""}) as h:
        try:
            await h.start()
        except Exception as error:  # the JSON-RPC error from session/new
            assert "TF_API_KEY is not set" in str(error)
        else:
            raise AssertionError("session/new should fail without TF_API_KEY")
