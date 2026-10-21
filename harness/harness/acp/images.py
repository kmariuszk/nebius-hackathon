"""`ImagesPlugin`: pictures the look tools took go into the asking agent's next model call, once (T07, D15).

Token Factory's tool messages carry text only, so a picture can't be a tool's
result. `look_at_board` and `look_at_figure` queue it on `BoardTools.images`;
before that agent's next model call this plugin appends one user message with
each picture after the line saying what it shows. LiteLLM sends a PNG as a
base64 `image_url` part and a figure by its URL. The message is added to that
request only, never to the session, so later calls don't pay for it again.

A model that can't see (I6) gets the line and a note instead of the picture.
Pictures that came with earlier prompts ("Include my view") are left out of
later turns the same way: that view is stale, and each costs a call about
1,400 tokens. Registered on the session's runner next to the trace plugin, so
it reaches every agent, sub-agents included.
"""

from __future__ import annotations

from google.adk.agents.callback_context import CallbackContext
from google.adk.models.llm_request import LlmRequest
from google.adk.plugins.base_plugin import BasePlugin
from google.genai import types

from harness.acp.mapping import NO_IMAGES, accepts_images
from harness.board.viewer import PendingImage

OLD_PICTURE = "[A picture came with this earlier message; it is no longer attached.]"


def is_picture(part: types.Part) -> bool:
    return bool(part.inline_data and (part.inline_data.mime_type or "").startswith("image/"))


def without_pictures(content: types.Content) -> types.Content:
    """`content` with each picture swapped for a note; a new object, so the session's event stays as it was."""
    parts = content.parts or []
    if not any(is_picture(p) for p in parts):
        return content
    return types.Content(role=content.role, parts=[types.Part(text=OLD_PICTURE) if is_picture(p) else p for p in parts])


class ImagesPlugin(BasePlugin):
    """The pictures for one ACP session's model calls."""

    def __init__(self, pending: list[PendingImage], models: dict[str, str]) -> None:
        super().__init__(name="acp_images")
        self.pending = pending  # BoardTools.images, filled by the look tools
        self.models = models

    async def before_model_callback(
        self, *, callback_context: CallbackContext, llm_request: LlmRequest
    ) -> None:
        current = callback_context.user_content
        llm_request.contents = [c if c == current else without_pictures(c) for c in llm_request.contents]
        agent, run = callback_context.agent_name, callback_context.invocation_id
        # this agent's pictures from this run; any from an earlier run (a cancelled turn) are dropped
        mine = [image for image in self.pending if image.agent == agent and image.invocation == run]
        self.pending[:] = [image for image in self.pending if image.agent != agent]
        if not mine:
            return None
        sees = accepts_images(self.models.get(agent, ""))
        parts: list[types.Part] = []
        for image in mine:
            parts += [types.Part(text=image.caption), image.part if sees else types.Part(text=NO_IMAGES)]
        llm_request.contents.append(types.Content(role="user", parts=parts))
        return None
