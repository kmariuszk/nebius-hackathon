"""What the papers MCP tools do, independent of MCP.

Every source runs on its own: one that fails or has no key is reported in
`skipped` and the others still return results. Every paper found is saved to
the store, which deduplicates it and makes `get_paper` work on its ID.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Iterable
from typing import Any, Literal

import httpx

from discovery.papers import Paper, format_id, ids_from_url, parse_id
from discovery.sources import Skipped, arxiv, openalex, pubmed, semantic_scholar, tavily
from discovery.store import Store

log = logging.getLogger(__name__)

SearchSource = Literal["pubmed", "openalex", "web"]
Strategy = Literal["keyword", "web", "pubmed_links", "citing", "recommend"]
SEARCH_SOURCES: tuple[SearchSource, ...] = ("pubmed", "openalex", "web")
SEED_STRATEGIES: tuple[Strategy, ...] = ("pubmed_links", "citing", "recommend")

# PubMed similar articles taken per seed; the list is ranked, so the top is enough.
SIMILAR_PER_SEED = 20


class Discovery:
    def __init__(self, client: httpx.AsyncClient, store: Store) -> None:
        self.client = client
        self.store = store

    async def search(
        self,
        query: str,
        limit: int = 20,
        sources: Iterable[SearchSource] = SEARCH_SOURCES,
        since: str | None = None,
    ) -> dict[str, Any]:
        jobs = {
            "pubmed": lambda: self._pubmed_search(query, limit, since),
            "openalex": lambda: openalex.search(self.client, query, limit, since),
            "web": lambda: self._web_search(query, limit, since),
        }
        found, skipped = await _run({name: jobs[name]() for name in dict.fromkeys(sources)})
        papers = self._save_all(_round_robin(found))
        return {
            "papers": [paper.to_summary(by) for paper, by in list(papers.values())[:limit]],
            "countsBySource": {name: len(hits) for name, hits in found.items()},
            "skipped": skipped,
        }

    async def find_candidates(
        self,
        seed_ids: list[str],
        exclude_ids: list[str] | None = None,
        strategies: Iterable[Strategy] = SEED_STRATEGIES,
        since: str | None = None,
        limit: int = 100,
        query: str | None = None,
    ) -> dict[str, Any]:
        seeds, skipped = [], []
        for seed_id in seed_ids:
            try:
                seeds.append(await self.get_paper(seed_id))
            except (ValueError, Skipped, httpx.HTTPError) as error:
                skipped.append(f"seed {seed_id}: {error}")
        excluded = {alias for seed in seeds for alias in seed.aliases()}
        for paper_id in exclude_ids or []:
            stored = self.store.get(paper_id)
            excluded |= set(stored.aliases()) if stored else {format_id(*parse_id(paper_id))}

        jobs: dict[str, Awaitable[list[Paper]]] = {}
        for strategy in dict.fromkeys(strategies):
            if strategy in ("keyword", "web") and not query:
                skipped.append(f"{strategy}: needs a query")
            elif strategy == "keyword":
                jobs[strategy] = self._keyword(query, limit, since)
            elif strategy == "web":
                jobs[strategy] = self._web_search(query, limit, since)
            elif strategy == "pubmed_links":
                jobs[strategy] = self._pubmed_links(seeds, limit, since)
            elif strategy == "citing":
                jobs[strategy] = self._citing(seeds, limit, since)
            elif strategy == "recommend":
                negative = [i for i in exclude_ids or [] if i not in seed_ids]
                jobs[strategy] = semantic_scholar.recommend(
                    self.client, [s.paper_id for s in seeds], negative, limit
                )
        found, failed = await _run(jobs)
        papers = self._save_all(_round_robin(found))
        candidates = [
            (paper, by) for paper, by in papers.values() if not excluded & set(paper.aliases())
        ]
        # Papers that several strategies found come first.
        candidates.sort(key=lambda entry: -len(entry[1]))
        return {
            "candidateIds": [paper.paper_id for paper, _ in candidates[:limit]],
            "countsByStrategy": {name: len(hits) for name, hits in found.items()},
            "skipped": skipped + failed,
        }

    async def resolve_seed(
        self, doi: str | None = None, pmid: str | None = None, title: str | None = None
    ) -> Paper:
        if pmid:
            paper = await self._by_pmid(pmid)
        elif doi:
            paper = await self._by_doi(doi)
        elif title:
            found = await pubmed.esearch(self.client, f"{title}[ti]", limit=1)
            paper = await self._by_pmid(found[0]) if found else None
        else:
            raise ValueError("Give a doi, pmid or title")
        if paper is None:
            raise ValueError(f"No paper found for {doi or pmid or title!r}")
        return self.store.save(paper)

    async def get_paper(self, paper_id: str) -> Paper:
        if stored := self.store.get(paper_id):
            return stored
        kind, value = parse_id(paper_id)
        if kind == "pmid":
            paper = await self._by_pmid(value)
        elif kind == "doi":
            paper = await self._by_doi(value)
        elif kind == "pmcid":
            found = await pubmed.pmid_for(self.client, f"{value}[pmcid]")
            paper = await self._by_pmid(found) if found else None
        elif kind == "arxiv":
            paper = next(iter(await arxiv.papers(self.client, [value])), None)
        elif kind == "openalex":
            paper = await openalex.work(self.client, "openalex", value)
        else:
            paper = None
        if paper is None:
            raise ValueError(f"No paper found for {paper_id!r}")
        return self.store.save(paper)

    async def _by_pmid(self, pmid: str) -> Paper | None:
        return next(iter(await pubmed.efetch(self.client, [pmid])), None)

    async def _by_doi(self, doi: str) -> Paper | None:
        if pmid := await pubmed.pmid_for(self.client, f"{doi}[doi]"):
            return await self._by_pmid(pmid)
        return await openalex.work(self.client, "doi", doi)

    async def _pubmed_search(self, query: str, limit: int, since: str | None) -> list[Paper]:
        pmids = await pubmed.esearch(self.client, query, limit, since)
        return _in_order(await pubmed.efetch(self.client, pmids), "pmid", pmids)

    async def _keyword(self, query: str, limit: int, since: str | None) -> list[Paper]:
        found, _ = await _run(
            {
                "pubmed": self._pubmed_search(query, limit, since),
                "openalex": openalex.search(self.client, query, limit, since),
            }
        )
        return [paper for _, paper in _round_robin(found)]

    async def _web_search(self, query: str, limit: int, since: str | None) -> list[Paper]:
        """Tavily hits, each resolved to a paper; hits without an identifier are dropped."""
        hits = await tavily.search(self.client, query, limit, since)
        ids = [ids_from_url(hit.url) for hit in hits]
        for found in ids:  # PMC and DOI pages: look the PMID up so PubMed supplies the record.
            for kind in ("pmcid", "doi"):
                if kind in found and (pmid := await pubmed.pmid_for(self.client, f"{found[kind]}[{kind}]")):
                    found["pmid"] = pmid
        pmids = [found["pmid"] for found in ids if "pmid" in found]
        records = {p.ids["pmid"]: p for p in await pubmed.efetch(self.client, pmids)} if pmids else {}
        arxiv_ids = [found["arxiv"] for found in ids if "arxiv" in found]
        records |= {p.ids["arxiv"]: p for p in await arxiv.papers(self.client, arxiv_ids)}
        papers = []
        for found in ids:
            paper = records.get(found.get("pmid", "")) or records.get(found.get("arxiv", ""))
            if paper is None and "doi" in found:
                try:
                    paper = await openalex.work(self.client, "doi", found["doi"])
                except Skipped:
                    paper = None
            if paper:
                papers.append(paper)
        return papers

    async def _pubmed_links(self, seeds: list[Paper], limit: int, since: str | None) -> list[Paper]:
        """PubMed's similar articles, citing papers and references of the seeds.

        A paper linked to more seeds ranks higher; among equals, similar articles
        keep PubMed's order and citing papers favour the newest (highest PMID).
        """
        seed_pmids = [seed.ids["pmid"] for seed in seeds if "pmid" in seed.ids]
        if not seed_pmids:
            raise Skipped("no seed has a PMID")
        score: dict[str, float] = {}
        for linkname, per_seed in [
            (pubmed.SIMILAR, SIMILAR_PER_SEED),
            (pubmed.CITED_IN, None),
            (pubmed.REFERENCES, None),
        ]:
            for linked in (await pubmed.elink(self.client, seed_pmids, linkname)).values():
                for rank, pmid in enumerate(linked[:per_seed]):
                    score[pmid] = score.get(pmid, 0) + 1 + (1 - rank / len(linked)) / 10
        score = {pmid: s for pmid, s in score.items() if pmid not in seed_pmids}
        top = sorted(score, key=lambda pmid: (-score[pmid], -int(pmid)))[:limit]
        papers = _in_order(await pubmed.efetch(self.client, top), "pmid", top)
        if since:
            papers = [p for p in papers if p.year is None or p.year >= int(since[:4])]
        return papers

    async def _citing(self, seeds: list[Paper], limit: int, since: str | None) -> list[Paper]:
        work_ids = []
        for seed in seeds:
            if "openalex" in seed.ids:
                work_ids.append(seed.ids["openalex"])
            elif "doi" in seed.ids and (work := await openalex.work(self.client, "doi", seed.ids["doi"])):
                work_ids.append(work.ids["openalex"])
                self.store.save(work)
        if not work_ids:
            raise Skipped("no seed found in OpenAlex")
        return await openalex.citing(self.client, work_ids, limit, since)

    def _save_all(self, found: Iterable[tuple[str, Paper]]) -> dict[str, tuple[Paper, list[str]]]:
        """Save each paper; returns paper ID → (stored paper, sources that found it)."""
        papers: dict[str, tuple[Paper, list[str]]] = {}
        for source, paper in found:
            if not paper.aliases():
                continue
            saved = self.store.save(paper)
            _, found_by = papers.get(saved.paper_id, (saved, []))
            papers[saved.paper_id] = (saved, found_by + [source] * (source not in found_by))
        return papers


async def _run(jobs: dict[str, Awaitable[list[Any]]]) -> tuple[dict[str, list[Any]], list[str]]:
    """Run the jobs concurrently; returns their results and a note for each that failed."""
    results = await asyncio.gather(*jobs.values(), return_exceptions=True)
    found, skipped = {}, []
    for name, result in zip(jobs, results):
        if isinstance(result, Skipped):
            skipped.append(f"{name}: {result}")
        elif isinstance(result, BaseException):
            log.error("%s failed", name, exc_info=result)
            skipped.append(f"{name}: {type(result).__name__}: {result}")
        else:
            found[name] = result
    return found, skipped


def _round_robin(found: dict[str, list[Paper]]) -> list[tuple[str, Paper]]:
    """Interleave the sources' ranked lists, so each source's best come first."""
    merged = []
    for rank in range(max((len(papers) for papers in found.values()), default=0)):
        merged += [(name, papers[rank]) for name, papers in found.items() if rank < len(papers)]
    return merged


def _in_order(papers: list[Paper], kind: str, order: list[str]) -> list[Paper]:
    position = {value: i for i, value in enumerate(order)}
    return sorted(papers, key=lambda paper: position.get(paper.ids.get(kind, ""), len(order)))
