"""Check the harness's connections: `uv run python -m harness.check`.

Run it once the keys are in `.env`. Each line is one check, and a failure
says what to fix. It covers the first-hour checklist item "run tool calling
through ADK LiteLlm with Super VL and Lightning on Token Factory".
"""

from __future__ import annotations

import asyncio
import sys
from collections.abc import Awaitable, Callable

import httpx
from google.adk.agents import LlmAgent
from google.adk.models.lite_llm import LiteLlm
from google.adk.runners import InMemoryRunner
from google.adk.tools.mcp_tool import McpToolset
from google.genai import types

from harness import models, settings, toolsets


async def token_factory_models() -> str:
    base = settings.get("TF_BASE_URL", models.TOKEN_FACTORY_URL).rstrip("/")
    headers = {"Authorization": f"Bearer {settings.require('TF_API_KEY')}"}
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(f"{base}/models", headers=headers)
        response.raise_for_status()
    served = {model["id"] for model in response.json()["data"]}
    wanted = {
        "SUPER_VL_MODEL": settings.get("SUPER_VL_MODEL", models.SUPER_VL),
        "LIGHTNING_MODEL": settings.get("LIGHTNING_MODEL", models.LIGHTNING),
    }
    nemotron = sorted(model for model in served if "nemotron" in model.lower())
    missing = [f"{name}={model}" for name, model in wanted.items() if model not in served]
    if missing:
        raise RuntimeError(f"not served: {', '.join(missing)}. Nemotron models served: {nemotron}")
    embedding = sorted(model for model in served if "embed" in model.lower())
    return f"{len(served)} models served; Nemotron: {nemotron}; embedding: {embedding}"


def add(a: int, b: int) -> int:
    """Adds two integers."""
    return a + b


async def tool_call(model: LiteLlm) -> str:
    agent = LlmAgent(
        name="check",
        model=model,
        instruction="Always use the add tool for arithmetic. Reply with the number only.",
        tools=[add],
    )
    runner = InMemoryRunner(agent=agent, app_name="check")
    session = await runner.session_service.create_session(app_name="check", user_id="check")
    message = types.Content(role="user", parts=[types.Part(text="What is 1234 + 4321?")])
    calls, reply = 0, ""
    async for event in runner.run_async(user_id="check", session_id=session.id, new_message=message):
        calls += len(event.get_function_calls())
        if event.is_final_response() and event.content and event.content.parts:
            reply = "".join(part.text or "" for part in event.content.parts)
    if not calls:
        raise RuntimeError(f"the model answered without calling the tool: {reply!r}")
    if "5555" not in reply:
        raise RuntimeError(f"the tool was called but the answer is wrong: {reply!r}")
    return f"called add, answered {reply.strip()}"


async def mcp_tools(toolset: McpToolset) -> str:
    try:
        tools = await toolset.get_tools()
    finally:
        await toolset.close()
    return "tools: " + ", ".join(sorted(tool.name for tool in tools))


CHECKS: list[tuple[str, Callable[[], Awaitable[str]]]] = [
    ("Token Factory catalogue", token_factory_models),
    ("Lightning tool call", lambda: tool_call(models.lightning())),
    ("Super VL tool call", lambda: tool_call(models.super_vl())),
    ("Papers MCP", lambda: mcp_tools(toolsets.papers())),
    ("Tavily MCP", lambda: mcp_tools(toolsets.tavily())),
]


async def main() -> int:
    failures = 0
    for name, check in CHECKS:
        try:
            print(f"ok    {name}: {await check()}")
        except Exception as error:  # Each check reports its own failure and the rest still run.
            failures += 1
            print(f"FAIL  {name}: {type(error).__name__}: {error}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
