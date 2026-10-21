"""Text embeddings from any OpenAI-compatible `/v1/embeddings` endpoint.

Token Factory's Qwen3-Embedding-8B is the default: it serves no Nemotron
embedding model (docs/Concept.md, NVIDIA model routing). `EMBED_BASE_URL`,
`EMBED_MODEL` and `EMBED_API_KEY` switch to another endpoint; the key falls
back to `TF_API_KEY`.

At most `EMBED_CONCURRENCY` requests (default 4) are in flight across the
process, and a request that times out, is rate limited or meets a server
error is tried twice more before its texts are given up on.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass

import httpx

from discovery.sources import key

DEFAULT_URL = "https://api.tokenfactory.nebius.com/v1/"
DEFAULT_MODEL = "Qwen/Qwen3-Embedding-8B"
# Texts per request; 32 titles and abstracts answer well inside the timeout.
BATCH = 32
TIMEOUT = 90
# Seconds before the second and third tries; a Retry-After header wins.
RETRY_WAITS = (2, 5)
# Qwen3 embeddings expect an instruction before a query and none before a document.
QUERY_INSTRUCTION = (
    "Instruct: Given a research question, retrieve paper titles and abstracts that help answer it\n"
    "Query: "
)


class EmbedError(Exception):
    """An embedding request failed on every try; the message says why."""


@dataclass
class EmbedResult:
    """A vector per text, None where the text's batch failed, and why, by text index."""

    vectors: list[list[float] | None]
    failures: dict[int, str]


# One semaphore per event loop, as one can't be shared between loops (tests run several).
_slots: tuple[asyncio.AbstractEventLoop, asyncio.Semaphore] | None = None


def _semaphore() -> asyncio.Semaphore:
    global _slots
    loop = asyncio.get_running_loop()
    if _slots is None or _slots[0] is not loop:
        _slots = (loop, asyncio.Semaphore(int(os.environ.get("EMBED_CONCURRENCY", "").strip() or 4)))
    return _slots[1]


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

    async def documents(self, texts: list[str]) -> EmbedResult:
        """Vectors for the texts, in order; a batch that fails on every try leaves None and why."""
        starts = range(0, len(texts), BATCH)
        results = await asyncio.gather(
            *(self._embed(texts[start : start + BATCH]) for start in starts), return_exceptions=True
        )
        found = EmbedResult([], {})
        for start, result in zip(starts, results):
            size = len(texts[start : start + BATCH])
            if isinstance(result, EmbedError):
                found.vectors += [None] * size
                found.failures |= dict.fromkeys(range(start, start + size), str(result))
            elif isinstance(result, BaseException):
                raise result
            else:
                found.vectors += result
        return found

    async def _embed(self, texts: list[str]) -> list[list[float]]:
        """One request, tried again after a timeout, a 429 or a 5xx; raises `EmbedError`."""
        for tries, wait in enumerate([*RETRY_WAITS, None], start=1):
            try:
                async with _semaphore():
                    response = await self.client.post(
                        self.base_url.rstrip("/") + "/embeddings",
                        headers={"Authorization": f"Bearer {self.api_key}"},
                        json={"model": self.model, "input": texts},
                        timeout=TIMEOUT,
                    )
            except httpx.TimeoutException:
                problem = "timed out"
            except httpx.HTTPError as error:
                raise EmbedError(f"embeddings failed: {type(error).__name__}: {error}") from error
            else:
                if response.is_success:
                    data = sorted(response.json()["data"], key=lambda item: item["index"])
                    return [item["embedding"] for item in data]
                problem = f"answered HTTP {response.status_code}"
                if response.status_code != 429 and response.status_code < 500:
                    raise EmbedError(f"embeddings {problem}")
                if wait is not None:
                    wait = _retry_after(response, wait)
            if wait is None:
                break
            await asyncio.sleep(wait)
        raise EmbedError(f"embeddings {problem} after {tries} tries")


def _retry_after(response: httpx.Response, default: float) -> float:
    """The seconds a Retry-After header asks for, at most a minute, else `default`."""
    try:
        return min(float(response.headers["Retry-After"]), 60)
    except (KeyError, ValueError):
        return default
