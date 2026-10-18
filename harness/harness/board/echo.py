"""The echo agent: no model, no keys, the same updates for every prompt.

`HARNESS_AGENT=echo uv run python -m harness` (or `--echo`). The board
service's ACP pipe (T03) and the chat panel (T05) are built against it. For
each prompt it sends, in order:

1. `plan`: "Read the prompt" in_progress, "Echo it back" pending
2. `tool_call` `echo: read_prompt`, kind `read`, in_progress, `_meta` {agent, model, runId}
3. `tool_call_update` completed, with a one-line summary and `_meta` {seconds, tokens, costUsd}
4. `plan`: "Read the prompt" completed, "Echo it back" in_progress
5. `agent_message_chunk`s whose texts join to the prompt's text
6. `plan`: both completed
7. the prompt result, `end_turn`

`session/cancel` stops it between steps with `cancelled`, the open card `failed`.
`tests/fixtures/echo-session.jsonl` is a recorded run.
"""

from __future__ import annotations

import asyncio
import contextlib
import re
import secrets
import time
from collections.abc import Awaitable, Callable
from typing import Any

from acp import plan_entry, text_block, tool_content, update_agent_message_text, update_plan
from acp.schema import PlanEntryStatus, StopReason, TextContentBlock, ToolCallProgress, ToolCallStart

from harness.board.ids import new_run_id

# Long enough to see the card in progress in the panel, short enough for tests.
TOOL_SECONDS = 0.3
CHUNK_SECONDS = 0.02


class Cancelled(Exception):
    """The turn was cancelled."""


def prompt_text(blocks: list[Any]) -> str:
    return "\n\n".join(b.text for b in blocks if isinstance(b, TextContentBlock)) or "(no text)"


class EchoSession:
    """One ACP session of the echo agent."""

    def __init__(self, send: Callable[[Any], Awaitable[None]]) -> None:
        self.send = send
        self.abort: asyncio.Event | None = None

    async def prompt(self, blocks: list[Any]) -> StopReason:
        self.abort = abort = asyncio.Event()
        text = prompt_text(blocks)
        card = "tc_" + secrets.token_hex(6)
        started = time.monotonic()
        try:
            await self.plan("in_progress", "pending")
            await self.send(
                ToolCallStart(
                    session_update="tool_call",
                    tool_call_id=card,
                    title="echo: read_prompt",
                    kind="read",
                    status="in_progress",
                    raw_input={"text": text},
                    field_meta={"agent": "echo", "model": "echo", "runId": new_run_id()},
                )
            )
            await self.pause(abort, TOOL_SECONDS)
            await self.send(
                ToolCallProgress(
                    session_update="tool_call_update",
                    tool_call_id=card,
                    status="completed",
                    raw_output={"chars": len(text)},
                    content=[tool_content(text_block(f"Read {len(text)} characters"))],
                    field_meta={"seconds": round(time.monotonic() - started, 2), "tokens": 0, "costUsd": 0},
                )
            )
            card = None
            await self.plan("completed", "in_progress")
            for chunk in re.findall(r"\S+\s*|\s+", text):
                await self.send(update_agent_message_text(chunk))
                await self.pause(abort, CHUNK_SECONDS)
            await self.plan("completed", "completed")
            return "end_turn"
        except Cancelled:
            if card:
                await self.send(
                    ToolCallProgress(
                        session_update="tool_call_update",
                        tool_call_id=card,
                        status="failed",
                        content=[tool_content(text_block("cancelled"))],
                    )
                )
            return "cancelled"

    async def plan(self, read: PlanEntryStatus, echo: PlanEntryStatus) -> None:
        await self.send(
            update_plan([plan_entry("Read the prompt", status=read), plan_entry("Echo it back", status=echo)])
        )

    @staticmethod
    async def pause(abort: asyncio.Event, seconds: float) -> None:
        """Sleep, or raise `Cancelled` as soon as the turn is cancelled."""
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(abort.wait(), seconds)
        if abort.is_set():
            raise Cancelled

    def cancel(self) -> None:
        if self.abort:
            self.abort.set()

    async def close(self) -> None:
        self.cancel()
