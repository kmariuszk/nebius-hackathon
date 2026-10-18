"""The discovery service against fake scholarly APIs (no network)."""

import json
from pathlib import Path

import httpx
import pytest
from mcp import Client

from discovery.server import build_server
from discovery.service import Discovery
from discovery.store import Store

FIXTURE = (Path(__file__).parent / "fixtures" / "pubmed_34290406.xml").read_text()


def article(pmid: str, title: str, doi: str = "") -> str:
    ids = f'<ArticleId IdType="pubmed">{pmid}</ArticleId>'
    if doi:
        ids += f'<ArticleId IdType="doi">{doi}</ArticleId>'
    return (
        f"<PubmedArticle><MedlineCitation><PMID>{pmid}</PMID><Article>"
        f"<Journal><Title>J</Title><JournalIssue><PubDate><Year>2024</Year></PubDate></JournalIssue></Journal>"
        f"<ArticleTitle>{title}</ArticleTitle><Abstract><AbstractText>About {title}</AbstractText></Abstract>"
        f"</Article></MedlineCitation><PubmedData><ArticleIdList>{ids}</ArticleIdList></PubmedData></PubmedArticle>"
    )


ARTICLES = {
    "34290406": None,  # The real fixture: the seed.
    "100": article("100", "Similar paper", "10.1/similar"),
    "200": article("200", "Citing paper"),
    "300": article("300", "Keyword hit", "10.1/keyword"),
}
LINKS = {
    "pubmed_pubmed": ["34290406", "100", "300"],
    "pubmed_pubmed_citedin": ["200", "100"],
    "pubmed_pubmed_refs": [],
}


def fake_apis(request: httpx.Request) -> httpx.Response:
    path, params = request.url.path, request.url.params
    if path.endswith("/esearch.fcgi"):
        term = params["term"]
        found = {"10.1038/s41586-021-03704-y[doi]": ["34290406"]}.get(term, ["300", "34290406"])
        return httpx.Response(200, json={"esearchresult": {"idlist": found}})
    if path.endswith("/efetch.fcgi"):
        body = "".join(
            FIXTURE.split("<PubmedArticleSet>")[1].split("</PubmedArticleSet>")[0]
            if pmid == "34290406"
            else ARTICLES[pmid]
            for pmid in params["id"].split(",")
        )
        return httpx.Response(200, text=f"<PubmedArticleSet>{body}</PubmedArticleSet>")
    if path.endswith("/elink.fcgi"):
        linkname = params["linkname"]
        linksets = [
            {"ids": [pmid], "linksetdbs": [{"linkname": linkname, "links": LINKS[linkname]}]}
            for pmid in params.get_list("id")
        ]
        return httpx.Response(200, json={"linksets": linksets})
    if path.startswith("/recommendations"):
        assert json.loads(request.content)["positivePaperIds"] == ["DOI:10.1038/s41586-021-03704-y"]
        paper = {"paperId": "abc", "title": "Recommended paper", "externalIds": {"DOI": "10.1/similar"}}
        return httpx.Response(200, json={"recommendedPapers": [paper]})
    return httpx.Response(404)


@pytest.fixture
def discovery(monkeypatch):
    for name in ("OPENALEX_API_KEY", "TAVILY_API_KEY", "NCBI_API_KEY", "SEMANTIC_SCHOLAR_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr("discovery.sources.pubmed._throttle.interval", 0)
    monkeypatch.setattr("discovery.sources.semantic_scholar._throttle.interval", 0)
    return Discovery(httpx.AsyncClient(transport=httpx.MockTransport(fake_apis)), Store())


async def test_search_reports_sources_without_keys_as_skipped(discovery):
    result = await discovery.search("melanoma", limit=5)
    assert [p["paperId"] for p in result["papers"]] == ["doi:10.1/keyword", "doi:10.1038/s41586-021-03704-y"]
    assert result["countsBySource"] == {"pubmed": 2}
    assert [note.split(":")[0] for note in result["skipped"]] == ["openalex", "web"]


async def test_find_candidates_merges_strategies_and_drops_seeds(discovery):
    seed = await discovery.resolve_seed(doi="10.1038/s41586-021-03704-y")
    assert seed.paper_id == "doi:10.1038/s41586-021-03704-y"

    result = await discovery.find_candidates([seed.paper_id], exclude_ids=["doi:10.1/keyword"])

    # The similar paper is also cited-in and recommended, so it comes first; the seed
    # and the excluded keyword hit never appear.
    assert result["candidateIds"] == ["doi:10.1/similar", "pmid:200"]
    # Counts are hits before seeds and exclusions are dropped.
    assert result["countsByStrategy"] == {"pubmed_links": 3, "recommend": 1}
    assert result["skipped"] == [
        "citing: OPENALEX_API_KEY is not set (free at https://openalex.org/settings/api)"
    ]
    assert (await discovery.get_paper("pmid:100")).title == "Similar paper"


async def test_tools_over_mcp(discovery):
    async with Client(build_server(discovery)) as client:
        tools = {tool.name for tool in (await client.list_tools()).tools}
        assert tools == {"search", "find_candidates", "resolve_seed", "get_paper"}
        result = await client.call_tool("search", {"query": "melanoma", "sources": ["pubmed"]})
        assert not result.is_error
        assert result.structured_content["countsBySource"] == {"pubmed": 2}

        missing = await client.call_tool("get_paper", {"paper_id": "isbn:1"})
        assert missing.is_error
