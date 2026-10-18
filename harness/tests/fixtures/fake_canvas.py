"""A stand-in canvas MCP over real HTTP, at the board service's path, recording each call's headers."""

from __future__ import annotations

import asyncio
import socket
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import uvicorn
from mcp.server import MCPServer
from mcp.server.mcpserver import Context

from harness.board.ids import paper_shape_id

BOARD_ID = "b_test"
PATH = f"/api/mcp/canvas/{BOARD_ID}"


class FakeCanvas:
    """Canned canvas tools; `calls` records tool, args, X-Run-Id, X-Model and Authorization."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.delay = 0.0  # seconds get_board takes, for cancel tests
        self.closing = False
        self.url = ""
        self.server = MCPServer(name="canvas")

        def record(ctx: Context, tool: str, **args: Any) -> None:
            headers = ctx.headers or {}
            self.calls.append(
                {
                    "tool": tool,
                    "args": args,
                    "runId": headers.get("x-run-id"),
                    "model": headers.get("x-model"),
                    "auth": headers.get("authorization"),
                }
            )

        @self.server.tool()
        async def get_board(ctx: Context) -> dict[str, Any]:
            """The board as a compact summary."""
            record(ctx, "get_board")
            started = time.monotonic()
            while time.monotonic() - started < self.delay and not self.closing:
                await asyncio.sleep(0.05)
            paper = {"paperId": "pmid:9", "title": "Seed paper", "status": "seed"}
            return {"papers": [paper], "clusters": [], "goals": []}

        @self.server.tool()
        async def add_papers(papers: list[dict[str, Any]], ctx: Context, near: str | None = None) -> dict[str, Any]:
            """Add paper cards."""
            record(ctx, "add_papers", papers=papers, near=near)
            return {"added": [paper_shape_id(p["paperId"]) for p in papers], "skipped": []}

        @self.server.tool()
        async def add_note(text: str, ctx: Context, paperId: str | None = None) -> dict[str, Any]:
            """Add a note."""
            record(ctx, "add_note", text=text, paperId=paperId)
            return {"added": ["shape:agent-note-0123456789ab"], "skipped": []}

        @self.server.tool()
        async def link_papers(links: list[dict[str, Any]], ctx: Context) -> dict[str, Any]:
            """Link papers."""
            record(ctx, "link_papers", links=links)
            return {"added": [], "skipped": []}

        @self.server.tool()
        async def set_scores(scores: list[dict[str, Any]]) -> dict[str, Any]:
            """Not one of board_assistant's tools, so it must never see it."""
            return {"updated": []}

    def tools_called(self) -> list[str]:
        return [call["tool"] for call in self.calls]


@contextmanager
def serve(fake: FakeCanvas) -> Iterator[FakeCanvas]:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    app = fake.server.streamable_http_app(streamable_http_path=PATH, stateless_http=True)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started:
        time.sleep(0.01)
    fake.url = f"http://127.0.0.1:{port}{PATH}"
    try:
        yield fake
    finally:
        fake.closing = True
        server.should_exit = True
        thread.join(timeout=5)
