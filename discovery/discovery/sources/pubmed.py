"""PubMed through NCBI E-utilities: ESearch, EFetch and ELink. No key needed.

Without `NCBI_API_KEY`, NCBI allows 3 requests a second from one IP; with one, 10.
"""

from __future__ import annotations

import asyncio
import os
import re
import xml.etree.ElementTree as ET

import httpx

from discovery.papers import Paper
from discovery.sources import Throttle, raise_for_status

BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
EFETCH_BATCH = 200

# ELink link names: similar articles, papers citing these, and their references.
SIMILAR = "pubmed_pubmed"
CITED_IN = "pubmed_pubmed_citedin"
REFERENCES = "pubmed_pubmed_refs"

# Kept under NCBI's limits, which count every request from our IP address.
_throttle = Throttle(8 if os.environ.get("NCBI_API_KEY") else 2.5)
RETRIES = 3


async def _get(client: httpx.AsyncClient, tool: str, params: dict | list) -> httpx.Response:
    extra = [("tool", "paper-discovery-canvas")]
    if api_key := os.environ.get("NCBI_API_KEY"):
        extra.append(("api_key", api_key))
    items = list(params.items()) if isinstance(params, dict) else list(params)
    for attempt in range(RETRIES):
        await _throttle.wait()
        response = await client.get(f"{BASE}/{tool}.fcgi", params=items + extra)
        if response.status_code != 429 or attempt == RETRIES - 1:
            break
        await asyncio.sleep(attempt + 1)
    raise_for_status(response)
    return response


async def esearch(
    client: httpx.AsyncClient, term: str, limit: int, since: str | None = None
) -> list[str]:
    """PMIDs matching a PubMed query, best match first."""
    params = {"db": "pubmed", "term": term, "retmax": limit, "retmode": "json", "sort": "relevance"}
    if since:
        params |= {"datetype": "pdat", "mindate": since.replace("-", "/"), "maxdate": "3000"}
    response = await _get(client, "esearch", params)
    return response.json()["esearchresult"]["idlist"]


async def efetch(client: httpx.AsyncClient, pmids: list[str]) -> list[Paper]:
    """Full records, abstracts included, for these PMIDs."""
    papers: list[Paper] = []
    for start in range(0, len(pmids), EFETCH_BATCH):
        batch = pmids[start : start + EFETCH_BATCH]
        params = {"db": "pubmed", "id": ",".join(batch), "retmode": "xml"}
        response = await _get(client, "efetch", params)
        papers += parse_articles(response.text)
    return papers


async def elink(client: httpx.AsyncClient, pmids: list[str], linkname: str) -> dict[str, list[str]]:
    """For each PMID, the PMIDs linked to it under `linkname`."""
    if not pmids:
        return {}
    params = [("dbfrom", "pubmed"), ("db", "pubmed"), ("linkname", linkname), ("retmode", "json")]
    params += [("id", pmid) for pmid in pmids]  # Repeated ids give one linkset per paper.
    response = await _get(client, "elink", params)
    links: dict[str, list[str]] = {}
    for linkset in response.json().get("linksets", []):
        linked = [
            str(pmid)
            for db in linkset.get("linksetdbs", [])
            if db.get("linkname") == linkname
            for pmid in db.get("links", [])
        ]
        links[str(linkset["ids"][0])] = linked
    return links


async def pmc_article(client: httpx.AsyncClient, pmcid: str) -> str:
    """The PMC article's JATS XML, body included when PMC may share it."""
    response = await _get(client, "efetch", {"db": "pmc", "id": pmcid})
    return response.text


async def pmid_for(client: httpx.AsyncClient, term: str) -> str | None:
    """The single PMID a field query such as `10.1038/x[doi]` or `PMC123[pmcid]` finds."""
    found = await esearch(client, term, limit=2)
    return found[0] if len(found) == 1 else None


def parse_articles(xml_text: str) -> list[Paper]:
    root = ET.fromstring(xml_text)
    return [paper for article in root.iter("PubmedArticle") if (paper := _parse(article))]


def _text(element: ET.Element | None) -> str:
    return " ".join("".join(element.itertext()).split()) if element is not None else ""


def _parse(article: ET.Element) -> Paper | None:
    citation = article.find("MedlineCitation")
    if citation is None or citation.find("Article") is None:
        return None
    body = citation.find("Article")
    ids = {"pmid": _text(citation.find("PMID"))}
    for article_id in article.iterfind("PubmedData/ArticleIdList/ArticleId"):
        kind = {"doi": "doi", "pmc": "pmcid"}.get(article_id.get("IdType", ""))
        if kind and article_id.text:
            ids[kind] = article_id.text
    parts = []
    for section in body.iterfind("Abstract/AbstractText"):
        label, text = section.get("Label"), _text(section)
        parts.append(f"{label}: {text}" if label else text)
    authors = []
    for author in body.iterfind("AuthorList/Author"):
        name = " ".join(filter(None, [_text(author.find("ForeName")), _text(author.find("LastName"))]))
        authors.append(name or _text(author.find("CollectiveName")))
    types = [_text(t) for t in body.iterfind("PublicationTypeList/PublicationType")]
    return Paper(
        ids=ids,
        title=_text(body.find("ArticleTitle")).rstrip("."),
        authors=[a for a in authors if a],
        year=_year(body),
        venue=_text(body.find("Journal/Title")) or None,
        abstract=" ".join(parts) or None,
        type="review" if "Review" in types else "preprint" if "Preprint" in types else "article",
    )


def _year(body: ET.Element) -> int | None:
    for path in ("Journal/JournalIssue/PubDate/Year", "ArticleDate/Year"):
        if (text := _text(body.find(path))).isdigit():
            return int(text)
    if match := re.search(r"\b(19|20)\d{2}\b", _text(body.find("Journal/JournalIssue/PubDate/MedlineDate"))):
        return int(match.group(0))
    return None
