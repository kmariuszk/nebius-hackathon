"""`citation_links`: which papers in a set cite which, with no model involved.

PubMed's reference lists (ELink `pubmed_pubmed_refs`) for the papers with a
PMID, since the board's red strings promise a PubMed fact; OpenAlex's
`referenced_works` for the papers PubMed doesn't have. Each link comes back
under the IDs the caller gave, whichever ID the reference list used.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable
from typing import Any

import httpx

from discovery.papers import Paper, format_id, parse_id
from discovery.service import Discovery, _run
from discovery.sources import Skipped, openalex, pubmed

MIN_PAPERS, MAX_PAPERS = 2, 200


async def citation_links(discovery: Discovery, paper_ids: list[str]) -> dict[str, Any]:
    """`links` ({from, to, source}, where `from` cites `to`, both in `paper_ids`) and `skipped`.

    Raises `ValueError` unless 2 to 200 different IDs are given.
    """
    unique = list(dict.fromkeys(paper_ids))
    if not MIN_PAPERS <= len(unique) <= MAX_PAPERS:
        raise ValueError(f"Give {MIN_PAPERS} to {MAX_PAPERS} different paper IDs, not {len(unique)}")
    papers, skipped = await _load(discovery, unique)
    # Every ID of every paper, to the ID it was given as.
    given: dict[str, str] = {}
    for paper_id, paper in papers.items():
        for alias in [format_id(*parse_id(paper_id)), *paper.aliases()]:
            given.setdefault(alias, paper_id)

    jobs: dict[str, Awaitable[list[tuple[str, str]]]] = {}
    if pmids := list(dict.fromkeys(paper.ids["pmid"] for paper in papers.values() if "pmid" in paper.ids)):
        jobs["pubmed"] = _pubmed(discovery.client, pmids, given)
    if rest := {paper_id for paper_id, paper in papers.items() if "pmid" not in paper.ids}:
        jobs["openalex"] = _openalex(discovery.client, rest, list(papers.values()), given)
    found, failed = await _run(jobs)

    # PubMed's first; each pair once, and no paper citing itself.
    links, seen = [], set()
    for source in ("pubmed", "openalex"):
        for pair in found.get(source, []):
            if pair[0] != pair[1] and pair not in seen:
                seen.add(pair)
                links.append({"from": pair[0], "to": pair[1], "source": source})
    return {"links": links, "skipped": skipped + failed}


async def _load(discovery: Discovery, paper_ids: list[str]) -> tuple[dict[str, Paper], list[str]]:
    """Each paper under the ID it was given as (which `Discovery._papers` doesn't keep), and a note
    for each that couldn't be loaded."""
    results = await asyncio.gather(*map(discovery.get_paper, paper_ids), return_exceptions=True)
    papers, skipped = {}, []
    for paper_id, result in zip(paper_ids, results):
        if isinstance(result, (ValueError, Skipped, httpx.HTTPError)):
            skipped.append(f"paper {paper_id}: {result}")
        elif isinstance(result, BaseException):
            raise result
        else:
            papers[paper_id] = result
    return papers, skipped


async def _pubmed(client: httpx.AsyncClient, pmids: list[str], given: dict[str, str]) -> list[tuple[str, str]]:
    """(citing, cited) pairs from the PubMed reference lists of these PMIDs."""
    references = await pubmed.elink(client, pmids, pubmed.REFERENCES)
    return [
        (given[f"pmid:{pmid}"], given[f"pmid:{ref}"])
        for pmid, refs in references.items()
        if f"pmid:{pmid}" in given
        for ref in refs
        if f"pmid:{ref}" in given
    ]


async def _openalex(
    client: httpx.AsyncClient, citing: set[str], papers: list[Paper], given: dict[str, str]
) -> list[tuple[str, str]]:
    """(citing, cited) pairs from the OpenAlex reference lists of the papers given as `citing`."""
    given = dict(given)
    # References are OpenAlex IDs, which PubMed's records lack: look those up by DOI.
    dois = dict.fromkeys(paper.ids["doi"] for paper in papers if "openalex" not in paper.ids and "doi" in paper.ids)
    for doi, work_id in (await openalex.by_doi(client, list(dois))).items():
        if paper_id := given.get(format_id("doi", doi)):
            given.setdefault(format_id("openalex", work_id), paper_id)
    works = {
        alias.removeprefix("openalex:"): paper_id for alias, paper_id in given.items() if alias.startswith("openalex:")
    }
    wanted = [work_id for work_id, paper_id in works.items() if paper_id in citing]
    references = await openalex.references(client, wanted) if wanted else {}
    return [
        (works[work_id], works[ref])
        for work_id, refs in references.items()
        if work_id in works
        for ref in refs
        if ref in works
    ]
