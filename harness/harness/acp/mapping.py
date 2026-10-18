"""ACP prompt blocks to the agent's message, and ADK events to ACP updates.

`to_genai_content` owns the context tags; T07, the board instructions and I4
only refer to them:

| ACP block | Part |
| --- | --- |
| `text` | the text |
| `resource`, mimeType `application/vnd.tldraw.shape+json` | `<selected-shape uri="tldraw://…">{json}</selected-shape>` |
| `resource`, uri `tldraw://<boardId>/viewport` | `<viewport>{json}</viewport>` |
| `resource`, uri `tldraw://<boardId>/changes` | `<board-changes>{json}</board-changes>` |
| any other `resource` | `<board-context uri="…">{text}</board-context>` |
| `resource_link` | the URI |
| `image` | the picture (its caption is the text block before it), or a note if the model can't see |

`EventMapper` turns one prompt's events into message and thought chunks, the
plan and usage. Tool cards come from `trace.AcpTracePlugin`, not from here.
"""

from __future__ import annotations

import base64
import html
from collections.abc import Callable
from typing import Any

from acp import plan_entry, update_agent_message_text, update_agent_thought_text, update_plan
from acp.schema import (
    BlobResourceContents,
    Cost,
    EmbeddedResourceContentBlock,
    ImageContentBlock,
    ResourceContentBlock,
    TextContentBlock,
    UsageUpdate,
)
from google.adk.events import Event
from google.genai import types

from harness import models
from harness.board.tools import PLAN_TOOL

SHAPE_MIME = "application/vnd.tldraw.shape+json"
NO_IMAGES = "[An image was attached here, but this model can't see images.]"
PLAN_STATUSES = {"pending", "in_progress", "completed"}
PLAN_PRIORITIES = {"high", "medium", "low"}


def accepts_images(model_id: str) -> bool:
    """I6: `models.accepts_images` once the harness owner adds it; until then Super VL sees."""
    check = getattr(models, "accepts_images", None)
    return check(model_id) if check else "-VL" in model_id


def to_genai_content(blocks: list[Any], images: bool = True) -> types.Content:
    parts: list[types.Part] = []
    for block in blocks:
        if isinstance(block, TextContentBlock):
            parts.append(types.Part(text=block.text))
        elif isinstance(block, ImageContentBlock):
            if images:
                blob = types.Blob(mime_type=block.mime_type, data=base64.b64decode(block.data))
                parts.append(types.Part(inline_data=blob))
            else:
                parts.append(types.Part(text=NO_IMAGES))
        elif isinstance(block, EmbeddedResourceContentBlock):
            parts.append(types.Part(text=resource_text(block.resource)))
        elif isinstance(block, ResourceContentBlock):
            parts.append(types.Part(text=block.uri))
    return types.Content(role="user", parts=parts or [types.Part(text="")])


def resource_text(resource: Any) -> str:
    uri = resource.uri
    if isinstance(resource, BlobResourceContents):
        return f'<board-context uri="{html.escape(uri)}">[binary, {resource.mime_type}]</board-context>'
    name = uri.rsplit("/", 1)[-1] if uri.startswith("tldraw://") else ""
    if name == "viewport":
        return f"<viewport>{resource.text}</viewport>"
    if name == "changes":
        return f"<board-changes>{resource.text}</board-changes>"
    if resource.mime_type == SHAPE_MIME:
        return f'<selected-shape uri="{html.escape(uri)}">{resource.text}</selected-shape>'
    return f'<board-context uri="{html.escape(uri)}">{resource.text}</board-context>'


def plan_from_args(args: dict[str, Any] | None) -> Any:
    entries = []
    for step in (args or {}).get("entries") or []:
        step = step if isinstance(step, dict) else {"content": str(step)}
        status = step.get("status") if step.get("status") in PLAN_STATUSES else "pending"
        priority = step.get("priority") if step.get("priority") in PLAN_PRIORITIES else "medium"
        entries.append(plan_entry(str(step.get("content", "")), status=status, priority=priority))
    return update_plan(entries)


class EventMapper:
    """One prompt's ADK events to ACP updates.

    In SSE mode a model call yields partial events with text deltas, then one
    final event with the whole text under the same event ID; the final text is
    only sent when no partials were, so nothing arrives twice.
    """

    def __init__(self, context_window: int, cost: Callable[[], float]) -> None:
        self.context_window = context_window
        self.cost = cost
        self.streamed: set[str] = set()
        self.used = 0

    def updates(self, event: Event) -> list[Any]:
        out: list[Any] = []
        parts = (event.content.parts or []) if event.content else []
        if event.partial or event.id not in self.streamed:
            for part in parts:
                if part.text:
                    chunk = update_agent_thought_text if part.thought else update_agent_message_text
                    out.append(chunk(part.text))
        if event.partial:
            if out:
                self.streamed.add(event.id)
            return out
        out.extend(plan_from_args(call.args) for call in event.get_function_calls() if call.name == PLAN_TOOL)
        if usage := event.usage_metadata:
            self.used = usage.total_token_count or (usage.prompt_token_count or 0) + (
                usage.candidates_token_count or 0
            )
            out.append(self.usage())
        if event.error_message and event.error_code != "INVOCATION_ABORTED":
            out.append(update_agent_message_text(f"Something went wrong: {event.error_message}"))
        return out

    def usage(self) -> UsageUpdate:
        """Tokens in context after the last model call, and the session's running cost."""
        return UsageUpdate(
            session_update="usage_update",
            used=self.used,
            size=self.context_window,
            cost=Cost(amount=round(self.cost(), 6), currency="USD"),
        )
