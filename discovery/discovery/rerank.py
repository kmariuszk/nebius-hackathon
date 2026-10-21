"""Listwise rerank with Nemotron 3.5 Super VL on Token Factory.

One request ranks every candidate at once, with the seed papers' abstracts in
context (docs/Concept.md, Discovery and ranking pipeline, step 8). Super VL's
long context fits the seeds plus about 100 candidates; the service trims the
list to `MAX_CANDIDATES` before it gets here.
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any

import httpx

from discovery.papers import Paper
from discovery.tokenfactory import chat_completion, first_json_object

SUPER_VL = "nvidia/Nemotron-3.5-Super-VL"
MAX_CANDIDATES = 100
# Characters of each abstract the model sees: enough for the method and the finding.
ABSTRACT_CHARS = 1500
# 100 abstracts take a while to read, more so with reasoning on.
TIMEOUT = 240.0

SYSTEM = """\
You rank candidate research papers for a researcher's literature search. \
Judge each candidate by how much it would help the researcher with their goal, \
using the seed papers (papers they already rely on) as the clearest sign of what they need. \
Prefer papers that add something the seeds don't already say; a near-duplicate of a seed is less useful. \
Reply with JSON only."""


def model_id() -> str:
    return os.environ.get("SUPER_VL_MODEL", "").strip() or SUPER_VL


def thinking() -> bool:
    """Whether Super VL reasons before ranking. Off unless `RERANK_THINKING=1`: on a small ranking
    it wrote about 1,200 reasoning tokens and took 15.6 s instead of 2.0 s (Oct 21), and
    `rank_papers` waits for it before the master can answer."""
    return os.environ.get("RERANK_THINKING", "").strip() == "1"


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
    """Rank `candidates` for `goal`; returns `{ranked, model, seconds, warnings}`.

    Each ranked entry is the candidate's summary plus `rank`, `score` (0 to 1,
    or None if the model gave none) and `reason`. Candidate numbers the model
    invents or repeats are dropped. If the reply is cut off or garbled, the
    complete entries in it are kept and `warnings` says so.
    """
    messages = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": prompt(goal, seeds, candidates, k)},
    ]
    started = time.monotonic()
    completion = await chat_completion(
        client, model_id(), messages, max_tokens=16000, timeout=TIMEOUT, thinking=thinking()
    )
    choice = completion["choices"][0]
    entries, complete = parse(choice["message"].get("content") or "")
    warnings = []
    if choice.get("finish_reason") == "length":
        warnings.append(
            f"Super VL's reply was cut off at the token limit; kept the {len(entries)} complete entries"
        )
    elif not complete:
        warnings.append(f"Super VL's reply was not clean JSON; kept the {len(entries)} complete entries")
    ranked, seen = [], set()
    for entry in entries:
        try:
            index = int(entry["index"])
        except (KeyError, TypeError, ValueError):
            continue
        if not 1 <= index <= len(candidates) or index in seen:
            continue
        seen.add(index)
        summary = candidates[index - 1].to_summary([])
        del summary["foundBy"]
        summary.update(
            rank=len(seen), score=score(entry.get("score")), reason=str(entry.get("reason") or "")
        )
        ranked.append(summary)
    return {
        "ranked": ranked[: max(1, k)],
        "model": model_id(),
        "seconds": round(time.monotonic() - started, 1),
        "warnings": warnings,
    }


def parse(content: str) -> tuple[list[dict[str, Any]], bool]:
    """The ranked entries in the reply, and whether it held a whole `{"ranked": [...]}`.

    Tolerates a code fence, prose or braces around the JSON. When no whole
    object parses (a reply cut off mid-list, say), each complete entry object
    is recovered on its own.
    """
    if (value := first_json_object(content, lambda value: "ranked" in value)) is not None:
        ranked = value["ranked"] if isinstance(value["ranked"], list) else []
        return [entry for entry in ranked if isinstance(entry, dict)], True
    entries = []
    for match in re.finditer(r"\{[^{}]*\}", content):
        try:
            entry = json.loads(match.group())
        except ValueError:
            continue
        if isinstance(entry, dict) and "index" in entry:
            entries.append(entry)
    return entries, False


def score(value: Any) -> float | None:
    """A 0-to-1 score from whatever the model wrote; a percentage is scaled down."""
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if 1 < number <= 100:
        number /= 100
    return round(number, 3) if 0 <= number <= 1 else None
