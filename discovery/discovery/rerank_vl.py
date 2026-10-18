"""Pointwise rerank with Llama Nemotron Rerank VL on NVIDIA's hosted API.

The `rerank_vl` backend of the `rerank` tool (docs/Concept.md, NVIDIA model
routing). It scores each candidate's title and abstract against the goal on
its own, so unlike the Super VL listwise backend it sees no seeds, writes no
reasons and drops nothing as off-topic. It answers in a second or two instead
of a minute. Token Factory serves no rerank model, so this runs on NVIDIA's
API with `NVIDIA_API_KEY`.
"""

from __future__ import annotations

import math
import os
import time
from typing import Any

import httpx

from discovery.papers import Paper
from discovery.rerank import ABSTRACT_CHARS
from discovery.sources import key

NVIDIA_URL = "https://ai.api.nvidia.com/v1/"
RERANK_VL = "nvidia/llama-nemotron-rerank-vl-1b-v2"
TIMEOUT = 60.0


def model_id() -> str:
    return os.environ.get("RERANK_VL_MODEL", "").strip() or RERANK_VL


def passage(paper: Paper) -> str:
    abstract = (paper.abstract or "").strip()
    if len(abstract) > ABSTRACT_CHARS:
        abstract = abstract[:ABSTRACT_CHARS].rsplit(" ", 1)[0] + " …"
    return f"{paper.title}\n{abstract}".strip()


async def rerank(
    client: httpx.AsyncClient, goal: str, candidates: list[Paper], k: int
) -> dict[str, Any]:
    """Rank `candidates` for `goal`; returns `{ranked, model, seconds, warnings}`.

    Each ranked entry is the candidate's summary plus `rank`, `score` (the
    model's logit through a sigmoid, 0 to 1) and an empty `reason`.
    """
    base = os.environ.get("NVIDIA_BASE_URL", "").strip() or NVIDIA_URL
    headers = {
        "Authorization": f"Bearer {key('NVIDIA_API_KEY', 'from https://build.nvidia.com')}",
        "Accept": "application/json",
    }
    body = {
        "model": model_id(),
        "query": {"text": goal},
        "passages": [{"text": passage(paper)} for paper in candidates],
        "truncate": "END",
    }
    started = time.monotonic()
    response = await client.post(
        f"{base.rstrip('/')}/retrieval/{model_id()}/reranking", json=body, headers=headers, timeout=TIMEOUT
    )
    response.raise_for_status()
    rankings = sorted(response.json()["rankings"], key=lambda entry: -entry["logit"])
    ranked = []
    for entry in rankings[: max(1, k)]:
        summary = candidates[entry["index"]].to_summary([])
        del summary["foundBy"]
        summary.update(
            rank=len(ranked) + 1, score=round(1 / (1 + math.exp(-entry["logit"])), 3), reason=""
        )
        ranked.append(summary)
    return {
        "ranked": ranked,
        "model": model_id(),
        "seconds": round(time.monotonic() - started, 1),
        "warnings": [],
    }
