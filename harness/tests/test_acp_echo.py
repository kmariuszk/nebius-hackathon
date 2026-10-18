"""Echo mode end to end: `python -m harness` as a subprocess, no keys, no model."""

import asyncio
import json
import re
from pathlib import Path

import pytest
from acp import PROTOCOL_VERSION, text_block

from fixtures.acp_client import harness

KEYLESS = {"HARNESS_AGENT": "echo", "TF_API_KEY": "", "TAVILY_API_KEY": ""}
RECORDING = Path(__file__).parent / "fixtures" / "echo-session.jsonl"


async def test_echo_answers_initialize_session_and_prompt_without_keys():
    async with harness(env=KEYLESS) as h:
        init = await h.conn.initialize(protocol_version=PROTOCOL_VERSION)
        assert init.protocol_version == PROTOCOL_VERSION
        caps = init.agent_capabilities
        assert caps.mcp_capabilities.http and caps.prompt_capabilities.image
        assert caps.prompt_capabilities.embedded_context and not caps.load_session
        assert init.agent_info.name == "paper-canvas-harness"

        session = (await h.conn.new_session(cwd=".", mcp_servers=[])).session_id
        assert re.fullmatch(r"s_[0-9a-f]{12}", session)

        text = "Find papers on  exhausted CD8 T cells\nin melanoma."
        result = await h.conn.prompt(session_id=session, prompt=[text_block(text)])

        assert result.stop_reason == "end_turn"
        kinds = [k for k in h.client.kinds() if k != "agent_message_chunk"]
        assert kinds == ["plan", "tool_call", "tool_call_update", "plan", "plan"]
        assert h.client.text() == text

        plans = [u for u in h.client.updates if u.session_update == "plan"]
        assert [[e.status for e in p.entries] for p in plans] == [
            ["in_progress", "pending"],
            ["completed", "in_progress"],
            ["completed", "completed"],
        ]
        card, done = (u for u in h.client.updates if u.session_update.startswith("tool_call"))
        assert (card.title, card.kind, card.status) == ("echo: read_prompt", "read", "in_progress")
        assert done.tool_call_id == card.tool_call_id and done.status == "completed"
        assert card.field_meta["agent"] == "echo"
        assert re.fullmatch(r"run_[0-9a-f]{12}", card.field_meta["runId"])
        assert set(done.field_meta) == {"seconds", "tokens", "costUsd"}
    h.stdout_messages()  # every stdout line is JSON


async def test_echo_flag_and_cancel():
    async with harness("--echo", env={"HARNESS_AGENT": "board_assistant"}) as h:
        session = await h.start()
        turn = asyncio.create_task(h.conn.prompt(session_id=session, prompt=[text_block("slow one")]))
        await h.client.wait_for(lambda u: u.session_update == "tool_call")
        started = asyncio.get_running_loop().time()
        await h.conn.cancel(session_id=session)
        result = await asyncio.wait_for(turn, 2)

        assert result.stop_reason == "cancelled"
        assert asyncio.get_running_loop().time() - started < 2
        assert h.client.updates[-1].session_update == "tool_call_update"
        assert h.client.updates[-1].status == "failed"
        assert h.client.text() == ""

        # The session takes the next prompt as usual.
        again = await h.conn.prompt(session_id=session, prompt=[text_block("again")])
        assert again.stop_reason == "end_turn"
        assert h.client.text() == "again"


@pytest.mark.parametrize("how", ["stdin", "sigterm"])
async def test_harness_exits_when_stdin_closes_or_on_sigterm(how):
    async with harness(env=KEYLESS) as h:
        session = await h.start()
        asyncio.create_task(h.conn.prompt(session_id=session, prompt=[text_block("bye")]))
        await h.client.wait_for(lambda u: u.session_update == "tool_call")
        assert await h.stop(how) < 3
        assert h.process.returncode == 0


async def test_the_recorded_echo_session_matches_a_live_run():
    """T05 tests its chat state against the recording; keep it in step with echo mode."""
    recorded = [json.loads(line) for line in RECORDING.read_text().splitlines()]
    recorded_kinds = [m["params"]["update"]["sessionUpdate"] for m in recorded if m.get("method") == "session/update"]
    prompt = next(m["params"]["prompt"] for m in recorded if m.get("method") == "session/prompt")

    async with harness(env=KEYLESS) as h:
        session = await h.start()
        await h.conn.prompt(session_id=session, prompt=[text_block(prompt[0]["text"])])

    live = [m["params"]["update"]["sessionUpdate"] for m in h.stdout_messages() if m.get("method") == "session/update"]
    assert live == recorded_kinds
