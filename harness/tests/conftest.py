"""Test helpers: a scripted model and a stand-in papers MCP over real HTTP."""

from __future__ import annotations

import asyncio
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


@pytest.fixture(autouse=True)
def default_models(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ignore model overrides in the repo's `.env`, which `harness.settings` loads on import."""
    for name in ("SUPER_VL_MODEL", "LIGHTNING_MODEL", "TF_BASE_URL", "MODEL_TIMEOUT"):
        monkeypatch.delenv(name, raising=False)


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
        self.fulltext_delay = 0.0  # seconds get_fulltext takes
        self.server = MCPServer(name="papers")

        @self.server.tool()
        async def search(query: str, limit: int = 20) -> dict[str, Any]:
            """Finds pmid:1, or pmid:3 for "spatial"; "slow" takes half a second."""
            self.calls.append(("search", {"query": query, "limit": limit}))
            if "slow" in query:
                await asyncio.sleep(0.5)
            paper_id = "pmid:3" if "spatial" in query else "pmid:1"
            paper = {"paperId": paper_id, "title": "Single-cell melanoma atlas", "foundBy": ["pubmed"]}
            return {"papers": [paper], "countsBySource": {"pubmed": 1}, "skipped": []}

        @self.server.tool()
        async def find_candidates(seed_ids: list[str]) -> dict[str, Any]:
            self.calls.append(("find_candidates", {"seed_ids": seed_ids}))
            return {"candidateIds": ["pmid:2"], "countsByStrategy": {"pubmed_links": 1}, "skipped": []}

        @self.server.tool()
        async def resolve_seed(doi: str | None = None, pmid: str | None = None) -> dict[str, Any]:
            self.calls.append(("resolve_seed", {"doi": doi, "pmid": pmid}))
            return {"paperId": f"doi:{doi}", "title": "Seed paper"}

        @self.server.tool()
        async def get_paper(paper_id: str) -> dict[str, Any]:
            self.calls.append(("get_paper", {"paper_id": paper_id}))
            return {"paperId": paper_id, "title": "Single-cell melanoma atlas", "abstract": "We map T cells."}

        @self.server.tool()
        async def rerank(
            goal: str,
            paper_ids: list[str],
            seed_ids: list[str] | None = None,
            exclude_ids: list[str] | None = None,
            k: int = 20,
        ) -> dict[str, Any]:
            """Not one of the search agent's tools, so it must never see it."""
            args = {"goal": goal, "paper_ids": paper_ids, "seed_ids": seed_ids, "exclude_ids": exclude_ids, "k": k}
            self.calls.append(("rerank", args))
            ranked = [{"rank": 1, "paperId": "pmid:1", "title": "Single-cell melanoma atlas", "reason": "Same cells."}]
            return {"ranked": ranked, "backend": "super_vl", "skipped": []}

        @self.server.tool()
        async def score_candidates(
            question: str, candidate_ids: list[str], seed_ids: list[str] | None = None, limit: int = 20
        ) -> dict[str, Any]:
            """Scores the candidates in reverse ID order, each closest to the first seed."""
            args = {"question": question, "candidate_ids": candidate_ids, "seed_ids": seed_ids, "limit": limit}
            self.calls.append(("score_candidates", args))
            top = [
                {"paperId": paper_id, "title": f"Paper {paper_id}", "year": 2024, "score": round(0.9 - 0.1 * i, 2),
                 "closestSeed": (seed_ids or [None])[0]}
                for i, paper_id in enumerate(sorted(candidate_ids, reverse=True)[:limit])
            ]
            return {"top": top, "scored": len(candidate_ids), "skipped": []}

        @self.server.tool()
        async def get_fulltext(paper_id: str, max_chars: int = 40_000) -> dict[str, Any]:
            self.calls.append(("get_fulltext", {"paper_id": paper_id}))
            await asyncio.sleep(self.fulltext_delay)
            sections = [{"title": "Results", "text": FULLTEXT}]
            figures = [{"figureId": "F2", "label": "Figure 2", "caption": "TOX expression by T cell state."}]
            return {"paperId": paper_id, "source": "pmc", "url": "https://pmc/PMC1/", "sections": sections,
                    "figures": figures, "truncated": False, "omittedSections": [], "skipped": []}

        @self.server.tool()
        async def check_quotes(paper_id: str, quotes: list[str]) -> dict[str, Any]:
            self.calls.append(("check_quotes", {"paper_id": paper_id, "quotes": quotes}))
            checked = [
                {"text": q, "verbatim": q in FULLTEXT, "section": "Results" if q in FULLTEXT else None,
                 "link": f"https://pmc/PMC1/#:~:text={q[:10]}" if q in FULLTEXT else None}
                for q in quotes
            ]
            return {"paperId": paper_id, "source": "pmc", "quotes": checked}


FULLTEXT = "We profiled 40,000 T cells from 12 melanomas. TOX marked every exhausted clone."


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
