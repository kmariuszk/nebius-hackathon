"""`HARNESS_MODEL=scripted:<path>`: every agent replays recorded turns instead of calling Token Factory.

The file is JSON with one list of turns per agent name; each turn has an
optional `thought`, `text` and `calls`:

    {"board_assistant": [
        {"calls": [{"name": "update_plan", "args": {"entries": [{"content": "Search"}]}}]},
        {"thought": "Two papers fit.", "text": "I added [Atlas](paper:pmid:1)."}],
     "search": [
        {"calls": [{"name": "search", "args": {"query": "CD8 exhaustion", "limit": 10}}]}]}

Streaming runs get the thought and text as partial chunks first and then the
whole turn, the way LiteLLM streams Super VL. Same idea as `tests/conftest.py`'s
`ScriptedLlm`, but loaded from a file so a subprocess can use it.
"""

from __future__ import annotations

import json
import re
from collections.abc import AsyncGenerator, Callable
from pathlib import Path
from typing import Any

from google.adk.agents import LlmAgent
from google.adk.agents.base_agent import BaseAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from harness.acp.trace import walk_agents

# Tokens reported per turn, so cards and usage show plausible numbers.
USAGE = (1200, 80)


class ScriptedModel(BaseLlm):
    model: str = "scripted"
    agent: str
    turns: list[dict[str, Any]]
    used: int = 0

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        if self.used >= len(self.turns):
            raise RuntimeError(f"the script has no turn {self.used + 1} for {self.agent}")
        turn = self.turns[self.used]
        self.used += 1
        thought, text = turn.get("thought", ""), turn.get("text", "")
        if stream:
            if thought:
                yield partial(types.Part(text=thought, thought=True))
            for chunk in re.findall(r"\S+\s*|\s+", text):
                yield partial(types.Part(text=chunk))
        parts = [types.Part(text=thought, thought=True)] if thought else []
        parts += [types.Part(text=text)] if text else []
        parts += [
            types.Part(function_call=types.FunctionCall(name=call["name"], args=call.get("args", {})))
            for call in turn.get("calls", [])
        ]
        tokens_in, tokens_out = turn.get("usage", USAGE)
        yield LlmResponse(
            content=types.Content(role="model", parts=parts),
            usage_metadata=types.GenerateContentResponseUsageMetadata(
                prompt_token_count=tokens_in,
                candidates_token_count=tokens_out,
                total_token_count=tokens_in + tokens_out,
            ),
        )


def partial(part: types.Part) -> LlmResponse:
    return LlmResponse(partial=True, content=types.Content(role="model", parts=[part]))


def use_script(root: BaseAgent, path: str) -> None:
    """Replace the model of every agent in the tree with its turns from the file.

    A `SearchTool` builds a fresh agent per call; each one continues its template's turns.
    """
    from harness.agents.master.candidates import SearchTool

    script = json.loads(Path(path).read_text(encoding="utf-8"))
    agents = list(walk_agents(root))
    for agent in agents:
        if isinstance(agent, LlmAgent):
            agent.model = ScriptedModel(agent=agent.name, turns=script.get(agent.name, []))
    for tool in (tool for agent in agents for tool in getattr(agent, "tools", [])):
        if isinstance(tool, SearchTool):
            tool._build = _scripted(tool._build, tool.agent.model)


def _scripted(build: Callable[[], LlmAgent], model: BaseLlm) -> Callable[[], LlmAgent]:
    def build_scripted() -> LlmAgent:
        agent = build()
        agent.model = model
        return agent

    return build_scripted
