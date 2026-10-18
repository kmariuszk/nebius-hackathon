"""Test helpers: a scripted model and a stand-in papers MCP over real HTTP."""

from __future__ import annotations

import os
import socket
import threading
import time
from collections.abc import AsyncGenerator, Iterator
from typing import Any

import pytest
import uvicorn
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from mcp.server import MCPServer
from pydantic import Field

# Agents build their model when imported; tests swap it for a ScriptedLlm.
os.environ.setdefault("TF_API_KEY", "test-key")


class ScriptedLlm(BaseLlm):
    """A model that replays canned turns and records every request it gets."""

    model: str = "scripted"
    turns: list[types.Content]
    requests: list[LlmRequest] = Field(default_factory=list)

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        self.requests.append(llm_request)
        yield LlmResponse(content=self.turns[len(self.requests) - 1])


def call(name: str, **args: Any) -> types.Content:
    return types.Content(role="model", parts=[types.Part(function_call=types.FunctionCall(name=name, args=args))])


def say(text: str) -> types.Content:
    return types.Content(role="model", parts=[types.Part(text=text)])


class FakePapers:
    """A papers MCP with canned results; `calls` records each tool call."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.server = MCPServer(name="papers")

        @self.server.tool()
        async def search(query: str, limit: int = 20) -> dict[str, Any]:
            self.calls.append(("search", {"query": query, "limit": limit}))
            paper = {"paperId": "pmid:1", "title": "Single-cell melanoma atlas", "foundBy": ["pubmed"]}
            return {"papers": [paper], "countsBySource": {"pubmed": 1}, "skipped": []}

        @self.server.tool()
        async def find_candidates(seed_ids: list[str]) -> dict[str, Any]:
            self.calls.append(("find_candidates", {"seed_ids": seed_ids}))
            return {"candidateIds": ["pmid:2"], "countsByStrategy": {"pubmed_links": 1}, "skipped": []}

        @self.server.tool()
        async def rerank(paper_ids: list[str]) -> list[str]:
            """Not one of the search agent's tools, so it must never see it."""
            return paper_ids


@pytest.fixture
def papers_mcp(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakePapers]:
    fake = FakePapers()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    app = fake.server.streamable_http_app(stateless_http=True)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started:
        time.sleep(0.01)
    monkeypatch.setenv("PAPERS_MCP_URL", f"http://127.0.0.1:{port}/mcp")
    yield fake
    server.should_exit = True
    thread.join(timeout=5)


@pytest.fixture
def canvas_mcp() -> Iterator[Any]:
    """A stand-in canvas MCP at /api/mcp/canvas/b_test; `calls` records each call's headers."""
    from fixtures.fake_canvas import FakeCanvas, serve

    with serve(FakeCanvas()) as fake:
        yield fake
