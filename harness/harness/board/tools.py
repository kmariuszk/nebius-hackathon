"""The board's tools for one chat (I1): canvas, papers, viewer and plan.

    def build(board: BoardTools | None = None) -> LlmAgent:
        board = board or BoardTools.from_env()
        return LlmAgent(..., tools=[board.canvas("add_papers", "link_papers"),
                                    board.papers("search"), *board.viewer(), board.plan()])

Under ACP the adapter makes one per session from `session/new`'s canvas MCP,
and every canvas call carries `X-Run-Id` (the prompt turn) and `X-Model` (the
calling agent's model) without the model ever seeing them (decision D7).
`from_env()` keeps `adk web` working from CANVAS_MCP_URL and BOARD_TOKEN.
"""

from __future__ import annotations

import logging
from typing import Any, Literal
from urllib.parse import urlsplit

from google.adk.agents.readonly_context import ReadonlyContext
from google.adk.tools import BaseTool, FunctionTool
from google.adk.tools.base_toolset import BaseToolset
from google.adk.tools.mcp_tool import McpToolset
from google.adk.tools.mcp_tool.mcp_session_manager import StreamableHTTPConnectionParams
from pydantic import BaseModel

from harness import settings, toolsets
from harness.board.viewer import viewer_tools

log = logging.getLogger(__name__)

PLAN_TOOL = "update_plan"
# Per-viewer tools (T06) change only the asker's screen; the canvas shows their effect, so no card.
VIEWER_TOOLS = frozenset({"focus", "highlight", "open_paper", "tour"})


class PlanStep(BaseModel):
    content: str
    status: Literal["pending", "in_progress", "completed"] = "pending"
    priority: Literal["high", "medium", "low"] = "medium"


def update_plan(entries: list[PlanStep]) -> dict[str, Any]:
    """Show the researcher your plan as a checklist in the chat.

    Call it at the start of a multi-step turn with every step, then again with
    the whole list whenever a step starts or finishes.

    Args:
        entries: Every step in order, each with content (one short line), status
            (pending, in_progress or completed) and priority (high, medium or low).
    """
    return {"ok": True, "steps": len(entries)}


class NoTools(BaseToolset):
    """Stands in for the canvas when the chat has none (plain ACP clients, `adk web` without CANVAS_MCP_URL)."""

    async def get_tools(self, readonly_context: ReadonlyContext | None = None) -> list[BaseTool]:
        return []


class BoardTools:
    """One chat's board: who is asking, on which board, and the tools that reach it."""

    def __init__(
        self,
        board_id: str = "",
        member_id: str = "",
        canvas_url: str | None = None,
        canvas_headers: dict[str, str] | None = None,
        papers_url: str | None = None,
        conn: Any = None,
        session_id: str | None = None,
    ) -> None:
        self.board_id = board_id
        self.member_id = member_id
        self.canvas_url = canvas_url
        self.canvas_headers = canvas_headers or {}
        self.papers_url = papers_url or settings.get("PAPERS_MCP_URL", toolsets.PAPERS_URL)
        self.conn = conn  # the ACP connection, for the viewer tools (T06, T07)
        self.session_id = session_id
        # Agent name to model ID, filled in once the agent tree is built, for X-Model.
        self.models: dict[str, str] = {}

    @classmethod
    def for_session(
        cls, conn: Any, session_id: str, canvas_url: str | None, canvas_headers: dict[str, str]
    ) -> BoardTools:
        """The board from `session/new`: the canvas URL ends in the board ID, the bearer is the member."""
        board_id = urlsplit(canvas_url).path.rstrip("/").rsplit("/", 1)[-1] if canvas_url else ""
        auth = next((v for k, v in canvas_headers.items() if k.lower() == "authorization"), "")
        member_id = auth.removeprefix("Bearer ").strip()
        return cls(board_id, member_id, canvas_url, canvas_headers, conn=conn, session_id=session_id)

    @classmethod
    def from_env(cls) -> BoardTools:
        """Today's behaviour, for `adk web`: CANVAS_MCP_URL, PAPERS_MCP_URL and BOARD_TOKEN."""
        return cls(canvas_url=settings.get("CANVAS_MCP_URL"), canvas_headers=toolsets.board_auth())

    def canvas(self, *tool_names: str) -> BaseToolset:
        """The canvas MCP limited to `tool_names`; no tools if this chat has no canvas."""
        if not self.canvas_url:
            log.warning("no canvas MCP for this chat, so no canvas tools: %s", ", ".join(tool_names))
            return NoTools()
        return McpToolset(
            connection_params=StreamableHTTPConnectionParams(
                url=self.canvas_url,
                headers=self.canvas_headers or None,
                timeout=toolsets.CONNECT_TIMEOUT,
                sse_read_timeout=toolsets.CALL_TIMEOUT,
            ),
            tool_filter=list(tool_names) or None,
            header_provider=self.run_headers,
        )

    def run_headers(self, ctx: ReadonlyContext) -> dict[str, str]:
        """Per call: the prompt turn's run ID and the calling agent's model."""
        headers = {}
        if run_id := ctx.state.get("run_id"):
            headers["X-Run-Id"] = run_id
        if model := self.models.get(ctx.agent_name):
            headers["X-Model"] = model
        return headers

    def papers(self, *tool_names: str) -> McpToolset:
        """The papers MCP from PAPERS_MCP_URL, with the same filter rules as `toolsets.papers`."""
        auth = {k: v for k, v in self.canvas_headers.items() if k.lower() == "authorization"}
        return toolsets.http_toolset(self.papers_url, tool_names, auth)

    def viewer(self) -> list[BaseTool]:
        """Focus, highlight, open paper and tour on this chat's researcher's screen (T06).

        Only a chat has a screen to point at, so there are none without an ACP
        session (`adk web`, `from_env()`). T07 adds look at the board or a paper.
        """
        if self.conn is None or self.session_id is None:
            return []
        return viewer_tools(self.conn, self.session_id)

    def plan(self) -> BaseTool:
        """`update_plan`: the chat shows it as a checklist (I3); it gets no tool card."""
        return FunctionTool(update_plan)
