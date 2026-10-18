"""What the papers MCP tools do, independent of MCP.

Every source runs on its own: one that fails or has no key is reported in
`skipped` and the others still return results. Every paper found is saved to
the store, which deduplicates it and makes `get_paper` work on its ID.
"""

from __future__ import annotations

import asyncio
import logging
import os
import xml.etree.ElementTree as ET
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import asdict
from typing import Any, Literal

import httpx

from discovery import fulltext
from discovery import rerank as listwise
from discovery import rerank_vl
from discovery.fulltext import FullText
from discovery.papers import Paper, default_url, format_id, ids_from_url, parse_id
from discovery.sources import Skipped, arxiv, openalex, pubmed, semantic_scholar, tavily
from discovery.store import Store

log = logging.getLogger(__name__)

SearchSource = Literal["pubmed", "openalex", "web"]
Strategy = Literal["keyword", "web", "pubmed_links", "citing", "recommend"]
SEARCH_SOURCES: tuple[SearchSource, ...] = ("pubmed", "openalex", "web")
SEED_STRATEGIES: tuple[Strategy, ...] = ("pubmed_links", "citing", "recommend")
RerankBackend = Literal["super_vl", "rerank_vl"]
RERANK_BACKENDS: tuple[RerankBackend, ...] = ("super_vl", "rerank_vl")

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
        seeds, skipped = await self._papers(seed_ids, "seed")
        excluded = {alias for seed in seeds for alias in seed.aliases()} | self._aliases(exclude_ids or [])

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

    async def rerank(
        self,
        goal: str,
        paper_ids: list[str],
        seed_ids: list[str] | None = None,
        exclude_ids: list[str] | None = None,
        k: int = 20,
        backend: RerankBackend | None = None,
    ) -> dict[str, Any]:
        k = max(1, k)
        backend = backend or os.environ.get("RERANK_BACKEND", "").strip() or "super_vl"
        if backend not in RERANK_BACKENDS:
            raise ValueError(
                f"Unknown rerank backend {backend!r} (RERANK_BACKEND): use one of {', '.join(RERANK_BACKENDS)}"
            )
        seeds, skipped = await self._papers(seed_ids or [], "seed")
        # Seeds and excluded papers are never ranked, under any of their IDs.
        seen = {alias for seed in seeds for alias in seed.aliases()} | self._aliases(exclude_ids or [])
        # Cap before loading: each ID missing from the store costs scholarly API calls.
        wanted = [i for i in dict.fromkeys(paper_ids) if i not in seen]
        if len(wanted) > listwise.MAX_CANDIDATES:
            skipped.append(
                f"{len(wanted) - listwise.MAX_CANDIDATES} candidates past the first "
                f"{listwise.MAX_CANDIDATES} were not ranked"
            )
            wanted = wanted[: listwise.MAX_CANDIDATES]
        candidates, failed = await self._papers(wanted, "candidate")
        skipped += failed
        # The same paper under two IDs is ranked once.
        unique = []
        for paper in candidates:
            if not seen & set(paper.aliases()):
                seen |= set(paper.aliases())
                unique.append(paper)
        if not unique:
            model = rerank_vl.model_id() if backend == "rerank_vl" else listwise.model_id()
            result = {"ranked": [], "model": model, "seconds": 0.0}
            skipped.append("no candidates to rank")
            return {**result, "backend": backend, "candidates": 0, "skipped": skipped}
        if backend == "rerank_vl":
            try:
                result = await rerank_vl.rerank(self.client, goal, unique, k)
            except Skipped as error:
                skipped.append(f"rerank_vl: {error}; ranked with super_vl")
                backend = "super_vl"
            except (httpx.HTTPError, KeyError, IndexError, TypeError) as error:
                log.error("rerank_vl failed", exc_info=error)
                skipped.append(f"rerank_vl: {type(error).__name__}: {error}; ranked with super_vl")
                backend = "super_vl"
        if backend == "super_vl":
            result = await listwise.rerank(self.client, goal, seeds, unique, k)
        skipped += result.pop("warnings")
        return {**result, "backend": backend, "candidates": len(unique), "skipped": skipped}

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

    async def get_fulltext(self, paper_id: str, max_chars: int = fulltext.DEFAULT_MAX_CHARS) -> dict[str, Any]:
        paper = await self.get_paper(paper_id)
        text, skipped = await self._fulltext(paper)
        return {
            "paperId": paper.paper_id,
            "title": paper.title,
            "source": text.source,
            "url": text.url,
            **text.fit(max_chars),
            "figures": [asdict(f) for f in text.figures],
            "skipped": skipped,
        }

    async def check_quotes(self, paper_id: str, quotes: list[str]) -> dict[str, Any]:
        paper = await self.get_paper(paper_id)
        text, _ = await self._fulltext(paper)
        checked = []
        for passage in quotes:
            section = text.find(passage)
            checked.append(
                {
                    "text": passage,
                    "verbatim": section is not None,
                    "section": section.title if section else None,
                    "link": fulltext.text_link(text.url, passage) if section else None,
                }
            )
        return {"paperId": paper.paper_id, "source": text.source, "quotes": checked}

    async def _fulltext(self, paper: Paper) -> tuple[FullText, list[str]]:
        """The paper's full text from the first source that has it, and why the others didn't."""
        if cached := self.store.get_fulltext(paper.paper_id):
            return cached, []
        if "pmcid" not in paper.ids and "pmid" in paper.ids:
            # OpenAlex and Semantic Scholar records often lack the PMCID that PubMed's has.
            try:
                if record := await self._by_pmid(paper.ids["pmid"]):
                    paper = self.store.save(record)
            except httpx.HTTPError as error:
                log.warning("PubMed lookup for %s failed: %s", paper.paper_id, error)
        url = paper.url or default_url(paper.ids)
        attempts: list[tuple[str, Callable[[], Awaitable[FullText | None]]]] = []
        if pmcid := paper.ids.get("pmcid"):
            pmc_url = f"https://pmc.ncbi.nlm.nih.gov/articles/{pmcid}/"
            attempts.append(("pmc", lambda: self._pmc(pmcid, pmc_url, paper.abstract)))
        if arxiv_id := paper.ids.get("arxiv"):
            attempts.append(("arxiv", lambda: self._web(f"https://arxiv.org/html/{arxiv_id}")))
        # PubMed and arXiv abstract pages hold no more than the record already does.
        for page in dict.fromkeys(filter(None, [paper.open_access_pdf, url])):
            if "arxiv.org" not in page and "pubmed.ncbi" not in page:
                attempts.append(("web", lambda page=page: self._web(page)))
        skipped = [] if attempts else ["no PMC, arXiv or publisher copy is known"]
        for name, attempt in attempts:
            try:
                if found := await attempt():
                    self.store.save_fulltext(paper.paper_id, found)
                    return found, skipped
                skipped.append(f"{name}: no full text there")
            except (Skipped, httpx.HTTPError, ET.ParseError) as error:
                skipped.append(f"{name}: {error}")
        return fulltext.from_abstract(paper.abstract, url), skipped

    async def _pmc(self, pmcid: str, url: str, abstract: str | None) -> FullText | None:
        return fulltext.from_jats(await pubmed.pmc_article(self.client, pmcid), url, abstract)

    async def _web(self, url: str) -> FullText | None:
        markdown = await tavily.extract(self.client, url)
        return fulltext.from_markdown(markdown, url) if markdown else None

    async def _papers(self, paper_ids: list[str], role: str) -> tuple[list[Paper], list[str]]:
        """The records for `paper_ids`, loaded concurrently, and a note for each that failed."""
        unique = list(dict.fromkeys(paper_ids))
        results = await asyncio.gather(*map(self.get_paper, unique), return_exceptions=True)
        papers, skipped = [], []
        for paper_id, result in zip(unique, results):
            if isinstance(result, (ValueError, Skipped, httpx.HTTPError)):
                skipped.append(f"{role} {paper_id}: {result}")
            elif isinstance(result, BaseException):
                raise result
            else:
                papers.append(result)
        return papers, skipped

    def _aliases(self, paper_ids: list[str]) -> set[str]:
        """Every known ID of each paper, from the store; malformed IDs are ignored."""
        aliases: set[str] = set()
        for paper_id in paper_ids:
            try:
                stored = self.store.get(paper_id)
                aliases |= set(stored.aliases()) if stored else {format_id(*parse_id(paper_id))}
            except ValueError:
                continue
        return aliases

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
