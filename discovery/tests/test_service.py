"""The discovery service against fake scholarly APIs (no network)."""

import json
from pathlib import Path

import httpx
import pytest
from mcp import Client

from discovery.papers import Paper
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
    "500": article("500", "Open access paper").replace(
        "</ArticleIdList>", '<ArticleId IdType="pmc">PMC500</ArticleId></ArticleIdList>'
    ),
}

FILLER = "Exhausted CD8 T cells lose effector function in chronic antigen exposure. " * 25
PMC_ARTICLE = f"""<pmc-articleset><article><front/><body>
<sec><title>Results</title><p>We find that “TOX drives exhaustion” in tumours
<fig id="F1"><label>Figure 1</label><caption><title>TOX levels.</title><p>Per patient.</p></caption></fig>
across patients.</p><sec><title>Spatial</title><p>{FILLER}</p></sec></sec>
<sec><title>Methods</title><p>{FILLER}</p></sec>
<sec><title>Author contributions</title><p>A wrote it.</p></sec>
</body></article></pmc-articleset>"""
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
    if path.endswith("/efetch.fcgi") and params["db"] == "pmc":
        return httpx.Response(200, text=PMC_ARTICLE) if params["id"] == "PMC500" else httpx.Response(400)
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
    if path.endswith("/chat/completions"):
        body = json.loads(request.content)
        assert body["model"] == "nvidia/Nemotron-3.5-Super-VL"
        prompt = body["messages"][1]["content"]
        # The seed is context, not a candidate: candidate 1 is the similar paper, 2 the citing one.
        assert "[S1] " in prompt
        assert "[1] Similar paper" in prompt and "[2] Citing paper" in prompt and "[3]" not in prompt
        ranked = [
            {"index": 2, "score": 0.9, "reason": "Cites the seed."},
            {"index": 99, "score": 0.8, "reason": "Invented."},
            {"index": 2, "score": 0.7, "reason": "Repeated."},
            {"index": 1, "score": 0.4, "reason": "Close to the seed."},
        ]
        reply = {"role": "assistant", "content": json.dumps({"ranked": ranked})}
        return httpx.Response(200, json={"choices": [{"message": reply}]})
    return httpx.Response(404)


@pytest.fixture
def discovery(monkeypatch):
    for name in (
        "OPENALEX_API_KEY", "TAVILY_API_KEY", "NCBI_API_KEY", "SEMANTIC_SCHOLAR_API_KEY",
        "SUPER_VL_MODEL", "TF_BASE_URL",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("TF_API_KEY", "test-key")
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


async def test_rerank_ranks_candidates_once_with_the_seeds_as_context(discovery):
    seed = await discovery.resolve_seed(doi="10.1038/s41586-021-03704-y")

    result = await discovery.rerank(
        "T cell exhaustion",
        # pmid:100 and its DOI are one paper; the seed is never ranked; isbn:1 is not an ID kind.
        ["pmid:100", "doi:10.1/similar", seed.paper_id, "pmid:200", "isbn:1"],
        seed_ids=[seed.paper_id],
        k=5,
    )

    # Invented and repeated candidate numbers are dropped.
    assert [(p["rank"], p["paperId"], p["reason"]) for p in result["ranked"]] == [
        (1, "pmid:200", "Cites the seed."),
        (2, "doi:10.1/similar", "Close to the seed."),
    ]
    assert result["ranked"][0]["title"] == "Citing paper"
    assert result["backend"] == "super_vl" and result["candidates"] == 2
    assert [note.split(":")[0] for note in result["skipped"]] == ["candidate isbn"]


async def test_rerank_without_candidates_skips_the_model(discovery):
    result = await discovery.rerank("anything", [])
    assert result["ranked"] == [] and result["skipped"] == ["no candidates to rank"]


async def test_tools_over_mcp(discovery):
    async with Client(build_server(discovery)) as client:
        tools = {tool.name for tool in (await client.list_tools()).tools}
        assert tools == {
            "search", "find_candidates", "rerank", "resolve_seed", "get_paper", "get_fulltext", "check_quotes",
        }
        result = await client.call_tool("search", {"query": "melanoma", "sources": ["pubmed"]})
        assert not result.is_error
        assert result.structured_content["countsBySource"] == {"pubmed": 2}

        missing = await client.call_tool("get_paper", {"paper_id": "isbn:1"})
        assert missing.is_error


async def test_fulltext_from_pmc_puts_methods_last_and_drops_back_matter(discovery):
    result = await discovery.get_fulltext("pmid:500")

    assert result["source"] == "pmc" and result["url"] == "https://pmc.ncbi.nlm.nih.gov/articles/PMC500/"
    assert [s["title"] for s in result["sections"]] == ["Abstract", "Results", "Methods"]
    # Figures are listed on their own, not left in the prose; subsections stay in their section.
    assert result["sections"][1]["text"].startswith(
        "We find that “TOX drives exhaustion” in tumours across patients. Spatial. Exhausted"
    )
    assert result["figures"] == [{"figureId": "F1", "label": "Figure 1", "caption": "TOX levels. Per patient."}]
    assert not result["truncated"] and result["skipped"] == []

    short = await discovery.get_fulltext("pmid:500", max_chars=2_000)
    # No section takes over a sixth of the budget, and Methods come last, so they are what it drops.
    assert short["truncated"] and short["omittedSections"] == []
    assert [len(s["text"]) <= 2_000 // 6 + 2 for s in short["sections"]] == [True, True, True]
    shortest = await discovery.get_fulltext("pmid:500", max_chars=600)
    assert [s["title"] for s in shortest["sections"]] == ["Abstract", "Results"]
    assert shortest["omittedSections"] == ["Methods"]


async def test_fulltext_finds_the_pmcid_an_openalex_record_lacks(discovery):
    discovery.store.save(Paper(ids={"openalex": "W1", "pmid": "500"}, title="Open access paper"))

    result = await discovery.get_fulltext("openalex:W1")

    assert result["source"] == "pmc" and result["paperId"] == "pmid:500"


async def test_check_quotes_accepts_verbatim_passages_only(discovery):
    result = await discovery.check_quotes(
        "pmid:500",
        [
            'We find that "TOX drives exhaustion" in tumours',  # Straight quotes match curly ones.
            "We find that TOX drives exhaustion in all tumours",
            "We find that … across patients",
        ],
    )

    assert [(q["verbatim"], q["section"]) for q in result["quotes"]] == [
        (True, "Results"), (False, None), (False, None),
    ]
    assert result["quotes"][0]["link"] == (
        "https://pmc.ncbi.nlm.nih.gov/articles/PMC500/"
        "#:~:text=We%20find%20that%20%22TOX%20drives%20exhaustion%22%20in%20tumours"
    )


async def test_fulltext_falls_back_to_the_abstract(discovery):
    # The DOI's landing page is tried through Tavily, which has no key here.
    result = await discovery.get_fulltext("pmid:100")
    assert result["source"] == "abstract" and result["url"] == "https://doi.org/10.1/similar"
    assert result["sections"] == [{"title": "Abstract", "text": "About Similar paper"}]
    assert result["skipped"] == ["web: TAVILY_API_KEY is not set (from https://app.tavily.com)"]

    no_copy = await discovery.get_fulltext("pmid:200")
    assert no_copy["source"] == "abstract" and no_copy["skipped"] == ["no PMC, arXiv or publisher copy is known"]
