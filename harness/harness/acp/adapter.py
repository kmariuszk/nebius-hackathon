"""`BoardHarness`, the ACP agent: `initialize`, `session/new`, `session/prompt`, `session/cancel`.

Each ACP session gets the agent named by `HARNESS_AGENT`, built with that
session's board tools, and a `SessionWorker` that runs its prompts one at a
time. `echo` gets the model-free `EchoSession` instead.
"""

from __future__ import annotations

import asyncio
import importlib
import inspect
import logging
import secrets
from collections.abc import Awaitable, Callable
from importlib.metadata import PackageNotFoundError, version
from typing import Any, Protocol
from urllib.parse import urlsplit

from acp import PROTOCOL_VERSION, RequestError
from acp.interfaces import Client
from acp.schema import (
    AgentCapabilities,
    HttpMcpServer,
    Implementation,
    InitializeResponse,
    McpCapabilities,
    NewSessionResponse,
    PromptCapabilities,
    PromptResponse,
    StopReason,
)

from harness import settings
from harness.board.echo import EchoSession

log = logging.getLogger(__name__)

Send = Callable[[Any], Awaitable[None]]


class Session(Protocol):
    async def prompt(self, blocks: list[Any]) -> StopReason: ...
    def cancel(self) -> None: ...
    async def close(self) -> None: ...


def sender(conn: Client, session_id: str) -> Send:
    """`session/update` for one session; quiet once the client has gone."""

    async def send(update: Any) -> None:
        try:
            await conn.session_update(session_id=session_id, update=update)
        except ConnectionError:
            log.debug("client gone, dropped %s", type(update).__name__)

    return send


def canvas_server(mcp_servers: list[Any] | None) -> tuple[str | None, dict[str, str]]:
    """URL and headers of the HTTP MCP server named `canvas`, origin swapped for BOARD_INTERNAL_URL."""
    server = next(
        (s for s in mcp_servers or [] if isinstance(s, HttpMcpServer) and s.name == "canvas"), None
    )
    if server is None:
        return None, {}
    url = server.url
    if internal := settings.get("BOARD_INTERNAL_URL"):
        origin = urlsplit(internal)
        url = urlsplit(url)._replace(scheme=origin.scheme, netloc=origin.netloc).geturl()
    return url, {h.name: h.value for h in server.headers}


def build_agent(name: str, board: Any) -> Any:
    """The agent for `HARNESS_AGENT`: ours, `harness.agents.<name>`, or `module:attr` (test agents)."""
    if name == "board_assistant":
        from harness.board.assistant import build
    elif ":" in name:
        module, attr = name.split(":", 1)
        build = getattr(importlib.import_module(module), attr)
    else:
        build = importlib.import_module(f"harness.agents.{name}.agent").build
    # I1: agents that take no board tools keep `build()` with no argument.
    return build(board=board) if "board" in inspect.signature(build).parameters else build()


class BoardHarness:
    """The ACP agent. One process serves one chat, which may open several sessions."""

    def __init__(self, agent: str) -> None:
        self.agent = agent
        self.conn: Client | None = None
        self.sessions: dict[str, Session] = {}

    def on_connect(self, conn: Client) -> None:
        self.conn = conn

    async def initialize(self, protocol_version: int, **kwargs: Any) -> InitializeResponse:
        try:
            package_version = version("harness")
        except PackageNotFoundError:
            package_version = "0.0.0"
        return InitializeResponse(
            protocol_version=PROTOCOL_VERSION,
            agent_capabilities=AgentCapabilities(
                load_session=False,
                mcp_capabilities=McpCapabilities(http=True),
                prompt_capabilities=PromptCapabilities(image=True, embedded_context=True),
            ),
            agent_info=Implementation(name="paper-canvas-harness", version=package_version),
        )

    async def new_session(
        self, cwd: str, mcp_servers: list[Any] | None = None, **kwargs: Any
    ) -> NewSessionResponse:
        assert self.conn is not None
        session_id = "s_" + secrets.token_hex(6)
        send = sender(self.conn, session_id)
        if self.agent == "echo":
            session: Session = EchoSession(send)
        else:
            session = self._worker(session_id, send, mcp_servers)
        self.sessions[session_id] = session
        log.info("session %s started (agent: %s)", session_id, self.agent)
        return NewSessionResponse(session_id=session_id)

    def _worker(self, session_id: str, send: Send, mcp_servers: list[Any] | None) -> Session:
        # ADK loads only when a real agent is asked for, so echo mode starts fast.
        from harness.acp import scripted
        from harness.acp.trace import agent_models
        from harness.acp.worker import SessionWorker
        from harness.board.tools import BoardTools

        assert self.conn is not None
        canvas_url, canvas_headers = canvas_server(mcp_servers)
        board = BoardTools.for_session(self.conn, session_id, canvas_url, canvas_headers)
        try:
            agent = build_agent(self.agent, board)
        except settings.MissingSetting as error:
            raise RequestError(-32603, str(error)) from error
        # Labels name the Nemotron model each agent was built with, also in scripted runs.
        board.models.update(agent_models(agent))
        if (model := settings.get("HARNESS_MODEL", "")).startswith("scripted:"):
            scripted.use_script(agent, model.removeprefix("scripted:"))
        return SessionWorker(send, agent, board)

    async def prompt(self, prompt: list[Any], session_id: str, **kwargs: Any) -> PromptResponse:
        session = self.sessions.get(session_id)
        if session is None:
            raise RequestError.invalid_params({"sessionId": session_id, "details": "unknown session"})
        return PromptResponse(stop_reason=await session.prompt(prompt))

    async def cancel(self, session_id: str, **kwargs: Any) -> None:
        if session := self.sessions.get(session_id):
            session.cancel()

    async def shutdown(self, timeout: float) -> None:
        """Stop every session: open turns are cancelled, workers close their MCP sessions."""
        sessions, self.sessions = list(self.sessions.values()), {}
        if not sessions:
            return
        tasks = [asyncio.create_task(session.close()) for session in sessions]
        _, pending = await asyncio.wait(tasks, timeout=timeout)
        for task in pending:
            task.cancel()
        if pending:
            log.warning("%d session(s) did not stop within %.0fs", len(pending), timeout)
