"""Listwise rerank with Nemotron 3.5 Super VL on Token Factory.

One request ranks every candidate at once, with the seed papers' abstracts in
context (docs/Concept.md, Discovery and ranking pipeline, step 8). Super VL's
long context fits the seeds plus about 100 candidates; the service trims the
list to `MAX_CANDIDATES` before it gets here.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

import httpx

from discovery.papers import Paper
from discovery.sources import key

TOKEN_FACTORY_URL = "https://api.tokenfactory.nebius.com/v1/"
SUPER_VL = "nvidia/Nemotron-3.5-Super-VL"
MAX_CANDIDATES = 100
# Characters of each abstract the model sees: enough for the method and the finding.
ABSTRACT_CHARS = 1500
# Super VL reasons before it answers, and 100 abstracts take a while to read.
TIMEOUT = 240.0

SYSTEM = """\
You rank candidate research papers for a researcher's literature search. \
Judge each candidate by how much it would help the researcher with their goal, \
using the seed papers (papers they already rely on) as the clearest sign of what they need. \
Prefer papers that add something the seeds don't already say; a near-duplicate of a seed is less useful. \
Reply with JSON only."""


def model_id() -> str:
    return os.environ.get("SUPER_VL_MODEL", "").strip() or SUPER_VL


def prompt(goal: str, seeds: list[Paper], candidates: list[Paper], k: int) -> str:
    parts = [f"Goal: {goal}", ""]
    if seeds:
        parts.append("Seed papers:")
        parts += [describe(f"S{i}", paper) for i, paper in enumerate(seeds, 1)]
        parts.append("")
    parts.append("Candidates:")
    parts += [describe(str(i), paper) for i, paper in enumerate(candidates, 1)]
    parts += [
        "",
        f"Return the {k} most useful candidates, best first, as "
        '{"ranked": [{"index": <candidate number>, "score": <0 to 1>, '
        '"reason": "<one sentence: what it adds for the goal, naming the seed it relates to if any>"}]}. '
        f"Leave out off-topic candidates even if that returns fewer than {k}. "
        "Base every reason on the title and abstract shown; never guess what a paper says.",
    ]
    return "\n".join(parts)


def describe(label: str, paper: Paper) -> str:
    abstract = (paper.abstract or "no abstract").strip()
    if len(abstract) > ABSTRACT_CHARS:
        abstract = abstract[:ABSTRACT_CHARS].rsplit(" ", 1)[0] + " …"
    meta = ", ".join(str(part) for part in (paper.year, paper.venue, paper.type) if part)
    return f"[{label}] {paper.title} ({meta})\n{abstract}"


async def rerank(
    client: httpx.AsyncClient, goal: str, seeds: list[Paper], candidates: list[Paper], k: int
) -> dict[str, Any]:
    """Rank `candidates` for `goal`; returns `{ranked, model, seconds}`.

    Each ranked entry is the candidate's summary plus `rank`, `score` and
    `reason`. Candidate numbers the model invents or repeats are dropped.
    """
    base = os.environ.get("TF_BASE_URL", "").strip() or TOKEN_FACTORY_URL
    headers = {"Authorization": f"Bearer {key('TF_API_KEY', 'Nebius Token Factory')}"}
    body = {
        "model": model_id(),
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": prompt(goal, seeds, candidates, k)},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0,
        "max_tokens": 16000,
    }
    started = time.monotonic()
    response = await client.post(
        base.rstrip("/") + "/chat/completions", json=body, headers=headers, timeout=TIMEOUT
    )
    response.raise_for_status()
    content = response.json()["choices"][0]["message"]["content"] or ""
    ranked, seen = [], set()
    for entry in parse(content).get("ranked", []):
        try:
            index = int(entry["index"])
        except (KeyError, TypeError, ValueError):
            continue
        if not 1 <= index <= len(candidates) or index in seen:
            continue
        seen.add(index)
        summary = candidates[index - 1].to_summary([])
        del summary["foundBy"]
        summary.update(rank=len(seen), score=entry.get("score"), reason=entry.get("reason", ""))
        ranked.append(summary)
    return {
        "ranked": ranked[:k],
        "model": model_id(),
        "seconds": round(time.monotonic() - started, 1),
    }


def parse(content: str) -> dict[str, Any]:
    """The JSON object in the reply, tolerating a code fence or text around it."""
    start, end = content.find("{"), content.rfind("}")
    if start == -1 or end < start:
        raise ValueError(f"Super VL did not return JSON: {content[:200]!r}")
    return json.loads(content[start : end + 1])
