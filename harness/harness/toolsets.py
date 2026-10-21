"""MCP toolsets: how agents reach paper and board capabilities.

Every capability lives behind MCP (docs/Concept.md, Protocols), so an agent
names only the tools it needs:

    tools=[toolsets.papers("search", "find_candidates")]

Naming no tools gives the agent everything that server offers.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

from google.adk.tools.mcp_tool import McpToolset
from google.adk.tools.mcp_tool.mcp_session_manager import StreamableHTTPConnectionParams

from harness import settings

PAPERS_URL = "http://127.0.0.1:8001/mcp"
TAVILY_URL = "https://mcp.tavily.com/mcp/"

# Seconds to connect to an MCP server, so an unreachable one fails fast.
CONNECT_TIMEOUT = 30.0
# Seconds one tool call may take. Papers tools call several scholarly APIs in a
# row, and `rerank` has Super VL read up to 100 abstracts (up to 4 minutes on
# its own), so this is well above the MCP client's 5-minute default.
CALL_TIMEOUT = 600.0


def papers(*tool_names: str) -> McpToolset:
    """The papers MCP in the discovery service: search, candidates, scoring, full text."""
    return http_toolset(settings.get("PAPERS_MCP_URL", PAPERS_URL), tool_names, board_auth())


def canvas(*tool_names: str) -> McpToolset:
    """The canvas MCP in the board service: every change to the shared board."""
    return http_toolset(settings.require("CANVAS_MCP_URL"), tool_names, board_auth())


def tavily(*tool_names: str) -> McpToolset:
    """Tavily's remote MCP server: `tavily-search`, `tavily-extract` and more."""
    headers = {"Authorization": f"Bearer {settings.require('TAVILY_API_KEY')}"}
    return http_toolset(settings.get("TAVILY_MCP_URL", TAVILY_URL), tool_names, headers)


def board_auth() -> dict[str, str]:
    """The researcher's board token, which the MCP servers use to attribute writes."""
    token = settings.get("BOARD_TOKEN")
    return {"Authorization": f"Bearer {token}"} if token else {}


def http_toolset(url: str, tool_names: Sequence[str], headers: dict[str, str]) -> McpToolset:
    """A toolset on a streamable HTTP MCP server, limited to `tool_names` if any."""
    return McpToolset(
        connection_params=StreamableHTTPConnectionParams(
            url=url,
            headers=headers or None,
            timeout=CONNECT_TIMEOUT,
            sse_read_timeout=CALL_TIMEOUT,
        ),
        tool_filter=list(tool_names) or None,
    )


def structured(response: Any) -> dict[str, Any]:
    """An MCP tool result as a dict: its structured content, or its text parsed as JSON."""
    if not isinstance(response, dict):
        return {}
    if isinstance(response.get("structuredContent"), dict):
        return response["structuredContent"]
    for block in response.get("content") or []:
        try:
            value = json.loads(block.get("text", ""))
        except (AttributeError, ValueError):
            continue
        if isinstance(value, dict):
            return value
    return {}


def failed(result: Any) -> bool:
    return not isinstance(result, dict) or bool(result.get("isError")) or "error" in result


def error_text(result: Any) -> str:
    if isinstance(result, dict):
        if "error" in result:
            return str(result["error"])
        texts = [c.get("text", "") for c in result.get("content") or [] if isinstance(c, dict)]
        if any(texts):
            return " ".join(texts)
    return json.dumps(result, default=str)[:300]
