"""Live: board_assistant on Nemotron 3.5 Super VL through the real ACP adapter.

Run with `uv run pytest -m live`; skipped unless the harness finds TF_API_KEY
(environment or the repo's .env). The canvas and papers MCPs are the test
stand-ins, so only Token Factory is real. Each test keeps to a few model calls
(the starting rate limit is 60 requests a minute). Assertions are about which
tools ran and what came back, not wording.
"""

import asyncio
import os
import subprocess
import sys

import pytest
from acp import text_block

from fixtures.acp_client import HARNESS_DIR, harness

pytestmark = pytest.mark.live

SUPER_VL = "nvidia/Nemotron-3.5-Super-VL"
TURN_SECONDS = 240


@pytest.fixture(scope="session")
def live_env() -> dict[str, str | None]:
    # tests/conftest.py sets a placeholder key; unset it so the harness reads the real one itself.
    env = {"HARNESS_AGENT": "board_assistant", "HARNESS_MODEL": None}
    if os.environ.get("TF_API_KEY") == "test-key":
        env["TF_API_KEY"] = None
    child = {k: v for k, v in {**os.environ, **env}.items() if v is not None}
    found = subprocess.run(
        [sys.executable, "-c", "from harness import settings; print(bool(settings.get('TF_API_KEY')))"],
        cwd=HARNESS_DIR, env=child, capture_output=True, text=True,
    ).stdout.strip()
    if found != "True":
        pytest.skip("live tests need TF_API_KEY")
    return env


async def ask(h, session: str, text: str):
    return await asyncio.wait_for(h.conn.prompt(session_id=session, prompt=[text_block(text)]), TURN_SECONDS)


async def test_super_vl_calls_add_note_and_confirms(canvas_mcp, papers_mcp, live_env):
    async with harness(env=live_env) as h:
        session = await h.start(canvas_mcp.url)
        result = await ask(h, session, "Add a note saying the CD8 cluster needs a review.")

    assert result.stop_reason == "end_turn"
    notes = [c for c in canvas_mcp.calls if c["tool"] == "add_note"]
    assert notes, f"no add_note call; canvas calls: {canvas_mcp.tools_called()}"
    text = notes[0]["args"]["text"]
    assert "CD8" in text and "review" in text.lower()
    assert notes[0]["model"] == SUPER_VL and notes[0]["runId"]
    assert h.client.text().strip()


async def test_nested_tool_cards_show_the_search_agents_calls(canvas_mcp, papers_mcp, live_env):
    async with harness(env=live_env) as h:
        session = await h.start(canvas_mcp.url)
        result = await ask(h, session, "Find two papers on exhausted CD8 T cells and add them to the board.")

    assert result.stop_reason == "end_turn"
    titles = [card.title for card in h.client.cards()]
    assert "search: search" in titles, titles
    assert "board_assistant: add_papers" in titles, titles
    assert "add_papers" in canvas_mcp.tools_called()


async def test_thoughts_stay_out_of_the_answer(canvas_mcp, papers_mcp, live_env):
    async with harness(env=live_env) as h:
        session = await h.start(canvas_mcp.url)
        result = await ask(h, session, "In one sentence, without using any tools: what is T cell exhaustion?")

    assert result.stop_reason == "end_turn"
    thoughts, answer = h.client.text("agent_thought_chunk").strip(), h.client.text().strip()
    assert thoughts, "Super VL reasons by default; expected thought chunks"
    assert answer
    assert thoughts not in answer


async def test_stop_during_a_live_turn_cancels_within_2_seconds(canvas_mcp, papers_mcp, live_env):
    async with harness(env=live_env) as h:
        session = await h.start(canvas_mcp.url)
        turn = asyncio.create_task(ask(h, session, "Find papers on exhausted CD8 T cells and add the best three."))
        await h.client.wait_for(
            lambda u: u.session_update in {"agent_thought_chunk", "agent_message_chunk", "tool_call"}, timeout=120
        )
        clock = asyncio.get_running_loop().time()
        await h.conn.cancel(session_id=session)
        result = await asyncio.wait_for(turn, 2)

    assert result.stop_reason == "cancelled"
    assert asyncio.get_running_loop().time() - clock < 2
