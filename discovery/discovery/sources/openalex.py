"""OpenAlex: keyword search, lookups by DOI or PMID, papers citing the seeds and reference lists.

OpenAlex now needs a free API key (`OPENALEX_API_KEY`); without one, requests
share a small daily budget per IP address that runs out quickly.
"""

from __future__ import annotations

from typing import Any

import httpx

from discovery.papers import Paper, normalise
from discovery.sources import Throttle, key, raise_for_status

BASE = "https://api.openalex.org"
_throttle = Throttle(10)
# IDs per filter request; OpenAlex takes up to 100 values in one OR filter.
BATCH = 50


async def _get(client: httpx.AsyncClient, path: str, params: dict[str, Any]) -> dict[str, Any]:
    params = {**params, "api_key": key("OPENALEX_API_KEY", "free at https://openalex.org/settings/api")}
    await _throttle.wait()
    response = await client.get(f"{BASE}{path}", params=params)
    raise_for_status(response)
    return response.json()


async def search(client: httpx.AsyncClient, query: str, limit: int, since: str | None = None) -> list[Paper]:
    params: dict[str, Any] = {"search": query, "per-page": min(limit, 100)}
    if since:
        params["filter"] = f"from_publication_date:{since}"
    data = await _get(client, "/works", params)
    return [parse_work(work) for work in data["results"] if work.get("title")]


async def work(client: httpx.AsyncClient, kind: str, value: str) -> Paper | None:
    """One work by `doi`, `pmid` or `openalex` ID, or None if OpenAlex has no such work."""
    lookup = {"doi": f"doi:{value}", "pmid": f"pmid:{value}", "openalex": value}[kind]
    try:
        return parse_work(await _get(client, f"/works/{lookup}", {}))
    except httpx.HTTPStatusError as error:
        if error.response.status_code == 404:
            return None
        raise


async def citing(
    client: httpx.AsyncClient, openalex_ids: list[str], limit: int, since: str | None = None
) -> list[Paper]:
    """Works citing any of these works, most cited first."""
    filters = ["cites:" + "|".join(openalex_ids)]
    if since:
        filters.append(f"from_publication_date:{since}")
    params = {"filter": ",".join(filters), "sort": "cited_by_count:desc", "per-page": min(limit, 100)}
    data = await _get(client, "/works", params)
    return [parse_work(work) for work in data["results"] if work.get("title")]


async def references(client: httpx.AsyncClient, work_ids: list[str]) -> dict[str, list[str]]:
    """For each of these works, the OpenAlex IDs of the works it references."""
    works = await _select(client, "openalex", work_ids, "id,referenced_works")
    return {
        normalise("openalex", work["id"]): [normalise("openalex", ref) for ref in work.get("referenced_works") or []]
        for work in works
    }


async def by_doi(client: httpx.AsyncClient, dois: list[str]) -> dict[str, str]:
    """The OpenAlex ID of each of these DOIs that OpenAlex has, by DOI."""
    # A comma or a pipe would split the filter, and OpenAlex would answer 400.
    values = [f"https://doi.org/{doi}" for doi in dois if not {",", "|"} & set(doi)]
    works = await _select(client, "doi", values, "id,doi")
    return {normalise("doi", work["doi"]): normalise("openalex", work["id"]) for work in works if work.get("doi")}


async def _select(client: httpx.AsyncClient, field: str, values: list[str], fields: str) -> list[dict[str, Any]]:
    """The works whose `field` is one of `values`, `BATCH` values a request, with only `fields`."""
    works: list[dict[str, Any]] = []
    for start in range(0, len(values), BATCH):
        params = {"filter": f"{field}:" + "|".join(values[start : start + BATCH]), "select": fields, "per-page": 100}
        works += (await _get(client, "/works", params))["results"]
    return works


def parse_work(work: dict[str, Any]) -> Paper:
    ids = work.get("ids") or {}
    source = ((work.get("primary_location") or {}).get("source")) or {}
    best = work.get("best_oa_location") or {}
    return Paper(
        ids={
            "openalex": ids.get("openalex") or work["id"],
            "doi": ids.get("doi") or work.get("doi") or "",
            "pmid": (ids.get("pmid") or "").rsplit("/", 1)[-1],
            "pmcid": (ids.get("pmcid") or "").rstrip("/").rsplit("/", 1)[-1],
        },
        title=work.get("title") or work.get("display_name") or "",
        authors=[a["author"]["display_name"] for a in work.get("authorships", []) if a.get("author")],
        year=work.get("publication_year"),
        venue=source.get("display_name"),
        abstract=_abstract(work.get("abstract_inverted_index")),
        open_access_pdf=best.get("pdf_url"),
        type=work.get("type"),
    )


def _abstract(inverted: dict[str, list[int]] | None) -> str | None:
    if not inverted:
        return None
    positions = {pos: word for word, places in inverted.items() for pos in places}
    return " ".join(positions[pos] for pos in sorted(positions))
