"""Semantic Scholar: recommendations steered by positive and negative papers.

Works without a key on a shared rate limit; `SEMANTIC_SCHOLAR_API_KEY` gives a
steady one.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

from discovery.papers import Paper, parse_id
from discovery.sources import Skipped, Throttle

BASE = "https://api.semanticscholar.org"
FIELDS = "title,year,venue,abstract,authors,externalIds,openAccessPdf,publicationTypes,citationCount"
_throttle = Throttle(1)

_PREFIX = {"doi": "DOI:", "pmid": "PMID:", "pmcid": "PMCID:", "arxiv": "ARXIV:", "s2": ""}


def s2_id(paper_id: str) -> str | None:
    """Our paper ID in Semantic Scholar's form, or None for kinds it doesn't take."""
    kind, value = parse_id(paper_id)
    if kind not in _PREFIX:
        return None
    return _PREFIX[kind] + (value.removeprefix("PMC") if kind == "pmcid" else value)


async def recommend(
    client: httpx.AsyncClient, positive: list[str], negative: list[str], limit: int
) -> list[Paper]:
    body = {
        "positivePaperIds": [i for i in map(s2_id, positive) if i],
        "negativePaperIds": [i for i in map(s2_id, negative) if i],
    }
    if not body["positivePaperIds"]:
        # the API answers 400 "No positive paper examples given"
        raise Skipped("no seed Semantic Scholar can look up")
    headers = {}
    if api_key := os.environ.get("SEMANTIC_SCHOLAR_API_KEY"):
        headers["x-api-key"] = api_key
    await _throttle.wait()
    response = await client.post(
        f"{BASE}/recommendations/v1/papers",
        params={"fields": FIELDS, "limit": min(limit, 500)},
        json=body,
        headers=headers,
    )
    response.raise_for_status()
    return [parse_paper(p) for p in response.json().get("recommendedPapers", []) if p.get("title")]


def parse_paper(paper: dict[str, Any]) -> Paper:
    external = paper.get("externalIds") or {}
    pmcid = external.get("PubMedCentral")
    types = paper.get("publicationTypes") or []
    return Paper(
        ids={
            "s2": paper["paperId"],
            "doi": external.get("DOI") or "",
            "pmid": str(external.get("PubMed") or ""),
            "pmcid": f"PMC{pmcid}" if pmcid else "",
            "arxiv": external.get("ArXiv") or "",
        },
        title=paper["title"],
        authors=[a["name"] for a in paper.get("authors") or [] if a.get("name")],
        year=paper.get("year"),
        venue=paper.get("venue") or None,
        abstract=paper.get("abstract"),
        open_access_pdf=(paper.get("openAccessPdf") or {}).get("url") or None,
        type="review" if "Review" in types else "article",
        cited_by=paper.get("citationCount"),
    )
