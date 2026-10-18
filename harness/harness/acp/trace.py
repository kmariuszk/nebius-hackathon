"""`AcpTracePlugin`: a tool card for every tool call, including calls inside sub-agents (I2, D8).

Registered on the session's runner; `AgentTool` hands the runner's plugins to
the agents it wraps, so one plugin sees every call. A card starts with
`_meta` {agent, model, runId} and ends with {seconds, tokens, costUsd}, where
tokens and cost sum the model calls made inside the tool (a sub-agent's card
carries its whole run). `update_plan` and the viewer tools get no card.
"""

from __future__ import annotations

import json
import logging
import secrets
import time
from collections.abc import Awaitable, Callable, Iterator
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from acp import text_block, tool_content
from acp.schema import ToolCallProgress, ToolCallStart, ToolKind
from google.adk.agents.base_agent import BaseAgent
from google.adk.agents.callback_context import CallbackContext
from google.adk.models.llm_response import LlmResponse
from google.adk.plugins.base_plugin import BasePlugin
from google.adk.tools import BaseTool, ToolContext
from google.adk.tools.agent_tool import AgentTool

from harness.acp import prices
from harness.board.tools import PLAN_TOOL, VIEWER_TOOLS

log = logging.getLogger(__name__)

HIDDEN = VIEWER_TOOLS | {PLAN_TOOL}
RAW_OUTPUT_BYTES = 8 * 1024
SUMMARY_CHARS = 140

# Cards open in the current task context: model calls made while a tool runs
# (in a sub-agent it started) are charged to every card on this stack.
_open_cards: ContextVar[tuple[str, ...]] = ContextVar("acp_open_cards", default=())


def walk_agents(root: BaseAgent) -> Iterator[BaseAgent]:
    """The agent and every agent below it, through sub-agents and `AgentTool`s."""
    seen: set[int] = set()
    stack = [root]
    while stack:
        agent = stack.pop()
        if id(agent) in seen:
            continue
        seen.add(id(agent))
        yield agent
        stack.extend(agent.sub_agents)
        stack.extend(t.agent for t in getattr(agent, "tools", []) if isinstance(t, AgentTool))


def model_id(agent: BaseAgent) -> str:
    model = getattr(agent, "model", "")
    name = model if isinstance(model, str) else getattr(model, "model", "")
    return name.removeprefix("openai/")


def agent_models(root: BaseAgent) -> dict[str, str]:
    """Agent name to the Nemotron model it runs on, for card labels and `X-Model`."""
    return {agent.name: model_id(agent) for agent in walk_agents(root)}


def kind_of(tool: BaseTool) -> ToolKind:
    name = tool.name
    if isinstance(tool, AgentTool):
        return "think"
    if name.startswith("get_"):
        return "read"
    if name in {"search", "find_candidates", "tavily-search", "tavily_search"}:
        return "search"
    if name in {"tavily-extract", "tavily_extract"}:
        return "fetch"
    if name.startswith(("add_", "set_", "link_", "mark_")):
        return "edit"
    return "other"


def failed(result: Any) -> bool:
    return isinstance(result, dict) and bool(result.get("isError") or "error" in result)


def summary(result: Any) -> str:
    """One line for the card: an MCP result's first text, an error, or the JSON."""
    text = result if isinstance(result, str) else None
    if isinstance(result, dict):
        if "error" in result:
            text = str(result["error"])
        elif contents := [c.get("text") for c in result.get("content") or [] if isinstance(c, dict)]:
            text = next((t for t in contents if t), None)
        elif set(result) == {"result"}:
            text = str(result["result"])
    if text is None:
        text = json.dumps(result, default=str, ensure_ascii=False)
    text = " ".join(text.split())
    return text if len(text) <= SUMMARY_CHARS else text[: SUMMARY_CHARS - 1] + "…"


def raw_output(result: Any) -> Any:
    text = json.dumps(result, default=str, ensure_ascii=False)
    return result if len(text.encode()) <= RAW_OUTPUT_BYTES else text[:RAW_OUTPUT_BYTES] + "…"


@dataclass
class Card:
    id: str
    started: float
    tokens: int = 0
    cost: float = 0.0

    def meta(self) -> dict[str, Any]:
        seconds = round(time.monotonic() - self.started, 2)
        return {"seconds": seconds, "tokens": self.tokens, "costUsd": round(self.cost, 6)}


class AcpTracePlugin(BasePlugin):
    """Tool cards and token costs for one ACP session."""

    def __init__(self, send: Callable[[Any], Awaitable[None]], models: dict[str, str]) -> None:
        super().__init__(name="acp_trace")
        self.send = send
        self.models = models
        self.cards: dict[str, Card] = {}
        # (invocation, function call) to card: IDs from the model can repeat across agents.
        self.calls: dict[tuple[str, str], str] = {}
        self.cost = 0.0

    async def before_tool_callback(
        self, *, tool: BaseTool, tool_args: dict[str, Any], tool_context: ToolContext
    ) -> None:
        if tool.name in HIDDEN:
            return None
        card = Card(id="tc_" + secrets.token_hex(6), started=time.monotonic())
        self.cards[card.id] = card
        self.calls[self._key(tool_context)] = card.id
        _open_cards.set(_open_cards.get() + (card.id,))
        agent = tool_context.agent_name
        await self._send(
            ToolCallStart(
                session_update="tool_call",
                tool_call_id=card.id,
                title=f"{agent}: {tool.name}",
                kind=kind_of(tool),
                status="in_progress",
                raw_input=tool_args,
                field_meta={
                    "agent": agent,
                    "model": self.models.get(agent, ""),
                    "runId": tool_context.state.get("run_id"),
                },
            )
        )
        return None

    async def after_tool_callback(
        self, *, tool: BaseTool, tool_args: dict[str, Any], tool_context: ToolContext, result: Any
    ) -> None:
        if card := self._close(tool_context):
            await self._finish(card, "failed" if failed(result) else "completed", summary(result), raw_output(result))
        return None

    async def on_tool_error_callback(
        self, *, tool: BaseTool, tool_args: dict[str, Any], tool_context: ToolContext, error: Exception
    ) -> None:
        if card := self._close(tool_context):
            await self._finish(card, "failed", f"{type(error).__name__}: {error}")
        return None

    async def after_model_callback(
        self, *, callback_context: CallbackContext, llm_response: LlmResponse
    ) -> None:
        usage = llm_response.usage_metadata
        if llm_response.partial or usage is None:
            return None
        tokens_in, tokens_out = usage.prompt_token_count or 0, usage.candidates_token_count or 0
        cost = prices.cost(self.models.get(callback_context.agent_name, ""), tokens_in, tokens_out)
        self.cost += cost
        for card_id in _open_cards.get():
            if card := self.cards.get(card_id):
                card.tokens += tokens_in + tokens_out
                card.cost += cost
        return None

    async def fail_open(self, reason: str) -> None:
        """Mark every card still open as failed: the turn was cancelled or broke off."""
        cards, self.cards, self.calls = list(self.cards.values()), {}, {}
        for card in cards:
            await self._finish(card, "failed", reason)

    def _key(self, tool_context: ToolContext) -> tuple[str, str]:
        return tool_context.invocation_id, tool_context.function_call_id or ""

    def _close(self, tool_context: ToolContext) -> Card | None:
        card_id = self.calls.pop(self._key(tool_context), None)
        if card_id is None:
            return None
        _open_cards.set(tuple(c for c in _open_cards.get() if c != card_id))
        return self.cards.pop(card_id, None)

    async def _finish(self, card: Card, status: Any, text: str, output: Any = None) -> None:
        await self._send(
            ToolCallProgress(
                session_update="tool_call_update",
                tool_call_id=card.id,
                status=status,
                raw_output=output,
                content=[tool_content(text_block(text))],
                field_meta=card.meta(),
            )
        )

    async def _send(self, update: Any) -> None:
        # ADK turns a plugin exception into a failed run; a lost card must not stop the agent.
        try:
            await self.send(update)
        except Exception:
            log.exception("could not send %s", type(update).__name__)
