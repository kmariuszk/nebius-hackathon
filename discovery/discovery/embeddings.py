"""Text embeddings from any OpenAI-compatible `/v1/embeddings` endpoint.

Token Factory's Qwen3-Embedding-8B is the default: it serves no Nemotron
embedding model (docs/Concept.md, NVIDIA model routing). `EMBED_BASE_URL`,
`EMBED_MODEL` and `EMBED_API_KEY` switch to another endpoint; the key falls
back to `TF_API_KEY`.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass

import httpx

from discovery.sources import key

DEFAULT_URL = "https://api.tokenfactory.nebius.com/v1/"
DEFAULT_MODEL = "Qwen/Qwen3-Embedding-8B"
# Texts per request; 64 titles and abstracts are well inside the model's context.
BATCH = 64
# Qwen3 embeddings expect an instruction before a query and none before a document.
QUERY_INSTRUCTION = (
    "Instruct: Given a research question, retrieve paper titles and abstracts that help answer it\n"
    "Query: "
)


@dataclass
class Embedder:
    client: httpx.AsyncClient
    base_url: str
    model: str
    api_key: str

    @classmethod
    def from_env(cls, client: httpx.AsyncClient) -> Embedder:
        """The configured embedder; raises `Skipped` naming the key if none is set."""
        api_key = os.environ.get("EMBED_API_KEY", "").strip() or key(
            "TF_API_KEY", "embeddings on Token Factory; or set EMBED_API_KEY"
        )
        return cls(
            client,
            os.environ.get("EMBED_BASE_URL", "").strip() or DEFAULT_URL,
            os.environ.get("EMBED_MODEL", "").strip() or DEFAULT_MODEL,
            api_key,
        )

    async def query(self, text: str) -> list[float]:
        prefix = QUERY_INSTRUCTION if "qwen3-embedding" in self.model.lower() else ""
        (vector,) = await self._embed([prefix + text])
        return vector

    async def documents(self, texts: list[str]) -> list[list[float]]:
        batches = [texts[i : i + BATCH] for i in range(0, len(texts), BATCH)]
        results = await asyncio.gather(*(self._embed(batch) for batch in batches))
        return [vector for batch in results for vector in batch]

    async def _embed(self, texts: list[str]) -> list[list[float]]:
        response = await self.client.post(
            self.base_url.rstrip("/") + "/embeddings",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json={"model": self.model, "input": texts},
            timeout=60,
        )
        response.raise_for_status()
        data = sorted(response.json()["data"], key=lambda item: item["index"])
        return [item["embedding"] for item in data]
