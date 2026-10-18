"""Tavily web search, restricted to sites whose URLs identify the paper.

A web hit isn't a paper yet (docs/Concept.md, Search sources): the caller
resolves each URL to a PMID, PMCID, DOI or arXiv ID before using it.
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx

from discovery.sources import key

URL = "https://api.tavily.com/search"

# Sites where `papers.ids_from_url` can read the paper's identifier from the URL.
DOMAINS = [
    "pubmed.ncbi.nlm.nih.gov",
    "pmc.ncbi.nlm.nih.gov",
    "biorxiv.org",
    "medrxiv.org",
    "arxiv.org",
]


@dataclass
class WebHit:
    url: str
    title: str
    content: str


async def search(
    client: httpx.AsyncClient, query: str, limit: int, since: str | None = None
) -> list[WebHit]:
    body = {
        "query": query,
        "max_results": min(limit, 20),
        "search_depth": "advanced",
        "include_domains": DOMAINS,
    }
    if since:
        body["start_date"] = since
    headers = {"Authorization": f"Bearer {key('TAVILY_API_KEY', 'from https://app.tavily.com')}"}
    response = await client.post(URL, json=body, headers=headers)
    response.raise_for_status()
    return [
        WebHit(url=hit["url"], title=hit.get("title", ""), content=hit.get("content", ""))
        for hit in response.json().get("results", [])
    ]
