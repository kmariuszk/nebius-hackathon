"""Drive `python -m harness` as a real subprocess with the ACP SDK's client side.

Every raw stdout line is kept, so tests can check that nothing but JSON-RPC
ever reached stdout.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from acp import PROTOCOL_VERSION, connect_to_agent
from acp.client.connection import ClientSideConnection
from acp.schema import HttpHeader, HttpMcpServer

HARNESS_DIR = Path(__file__).resolve().parents[2]
LIMIT = 50 * 1024 * 1024


class RecordingClient:
    """An ACP client that records every session update and `_canvas/*` notification and request.

    `answers` maps an extension method ("canvas/snapshot") to its result, or to an
    exception to fail with; methods without an answer fail as not implemented.
    """

    def __init__(self) -> None:
        self.updates: list[Any] = []
        self.notifications: list[tuple[str, dict[str, Any]]] = []
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.answers: dict[str, Any] = {}
        self.changed = asyncio.Event()

    async def session_update(self, session_id: str, update: Any, **kwargs: Any) -> None:
        self.updates.append(update)
        self.changed.set()

    async def request_permission(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError("the harness never asks for permission in v0")

    async def ext_notification(self, method: str, params: dict[str, Any]) -> None:
        self.notifications.append((method, params))

    async def ext_method(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.requests.append((method, params))
        answer = self.answers.get(method)
        if answer is None:
            raise NotImplementedError(method)
        if isinstance(answer, Exception):
            raise answer
        return answer

    async def wait_for(self, predicate: Any, timeout: float = 10) -> Any:
        """The first recorded update matching `predicate`, waiting for it if needed."""
        async with asyncio.timeout(timeout):
            while True:
                if match := next((u for u in self.updates if predicate(u)), None):
                    return match
                self.changed.clear()
                await self.changed.wait()

    def kinds(self) -> list[str]:
        return [u.session_update for u in self.updates]

    def text(self, kind: str = "agent_message_chunk") -> str:
        return "".join(u.content.text for u in self.updates if u.session_update == kind)

    def cards(self) -> list[Any]:
        return [u for u in self.updates if u.session_update == "tool_call"]


class Harness:
    def __init__(self, process: asyncio.subprocess.Process, client: RecordingClient) -> None:
        self.process = process
        self.client = client
        self.stdout: list[bytes] = []
        self.stderr: list[bytes] = []
        self.reader = asyncio.StreamReader(limit=LIMIT)
        self.conn: ClientSideConnection = connect_to_agent(client, process.stdin, self.reader)

    async def pump(self) -> None:
        async def out() -> None:
            while line := await self.process.stdout.readline():
                self.stdout.append(line)
                self.reader.feed_data(line)
            self.reader.feed_eof()

        async def err() -> None:
            while line := await self.process.stderr.readline():
                self.stderr.append(line)

        await asyncio.gather(out(), err())

    async def start(self, canvas_url: str | None = None, member: str = "m_ana") -> str:
        await self.conn.initialize(protocol_version=PROTOCOL_VERSION)
        servers = []
        if canvas_url:
            auth = HttpHeader(name="Authorization", value=f"Bearer {member}")
            servers.append(HttpMcpServer(type="http", name="canvas", url=canvas_url, headers=[auth]))
        return (await self.conn.new_session(cwd=str(HARNESS_DIR), mcp_servers=servers)).session_id

    def stdout_messages(self) -> list[dict[str, Any]]:
        """Every stdout line as JSON; raises if any line isn't."""
        return [json.loads(line) for line in self.stdout]

    def stderr_text(self) -> str:
        return b"".join(self.stderr).decode(errors="replace")

    async def stop(self, how: str = "stdin", timeout: float = 3.0) -> float:
        """Close stdin or send SIGTERM; returns how long the process took to exit."""
        loop = asyncio.get_running_loop()
        started = loop.time()
        if self.process.returncode is None:
            if how == "stdin":
                self.process.stdin.close()
            else:
                self.process.send_signal(signal.SIGTERM)
            try:
                await asyncio.wait_for(self.process.wait(), timeout)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()
                raise
        return loop.time() - started


@asynccontextmanager
async def harness(*args: str, env: dict[str, str | None] | None = None) -> AsyncIterator[Harness]:
    """`python -m harness` with `env` on top of ours (None unsets); stopped (stdin closed) on exit."""
    merged = {**os.environ, "BOARD_INTERNAL_URL": "", **(env or {})}
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "harness",
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={k: v for k, v in merged.items() if v is not None},
        cwd=HARNESS_DIR,
        limit=LIMIT,
    )
    running = Harness(process, RecordingClient())
    pump = asyncio.create_task(running.pump())
    try:
        yield running
    finally:
        try:
            await running.stop()
        finally:
            await running.conn.close()
            await asyncio.wait([pump], timeout=5)
