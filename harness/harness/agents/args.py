"""Tool arguments the model writes as text, cleaned before an MCP call.

Lightning writes `since: "None"` or `sources: "None"` for optional arguments
it doesn't use. The papers MCP took `since` as a date, so every source came
back empty or with HTTP 400 and the search agent kept retrying. Dropping
those arguments leaves the server's defaults. Every agent's before-tool
callback starts with `clean_args`.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from typing import Any

from google.adk.tools.base_tool import BaseTool
from google.adk.tools.mcp_tool.mcp_tool import McpTool
from google.adk.tools.tool_context import ToolContext

log = logging.getLogger(__name__)

PLACEHOLDERS = frozenset({"None", "none", "null", "NULL", "undefined", ""})

BeforeTool = Callable[..., dict[str, Any] | None]


def clean_args(*, tool: BaseTool, args: dict[str, Any], tool_context: ToolContext) -> None:
    """Drop optional MCP arguments the model wrote as a placeholder string."""
    if not isinstance(tool, McpTool):
        return None
    required = set(input_schema(tool).get("required") or [])
    dropped = [name for name, value in args.items()
               if name not in required and isinstance(value, str) and value in PLACEHOLDERS]
    for name in dropped:
        log.debug("dropped %s=%s from %s", name, json.dumps(args.pop(name)), tool.name)
    if dropped:
        log.info("%s: dropped %d placeholder argument%s: %s",
                 tool.name, len(dropped), "s" * (len(dropped) > 1), ", ".join(dropped))
    return None


def input_schema(tool: McpTool) -> dict[str, Any]:
    """The MCP tool's input schema; MCP SDK 2 names it `input_schema`, 1 `inputSchema`."""
    raw = tool.raw_mcp_tool
    return getattr(raw, "input_schema", None) or getattr(raw, "inputSchema", None) or {}


def chain(*callbacks: BeforeTool) -> BeforeTool:
    """Run before-tool callbacks in order; the first one that returns a dict wins."""

    def run(*, tool: BaseTool, args: dict[str, Any], tool_context: ToolContext) -> dict[str, Any] | None:
        for callback in callbacks:
            if (result := callback(tool=tool, args=args, tool_context=tool_context)) is not None:
                return result
        return None

    run.callbacks = callbacks  # type: ignore[attr-defined]
    return run
