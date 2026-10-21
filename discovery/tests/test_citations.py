"""`citation_links` against canned PubMed and OpenAlex reference lists (no network)."""

import httpx
import pytest
from mcp import Client
from test_service import discovery, fake_apis  # noqa: F401 (discovery is a fixture)

from discovery.citations import citation_links
from discovery.papers import Paper
from discovery.server import build_server
from discovery.sources import openalex

# PubMed reference lists: 100 cites 200 (and a paper not in the set), 200 cites 300 (and itself, twice).
REFS = {"100": ["200", "999"], "200": ["300", "200", "300"], "300": [], "500": ["34290406"]}
# OpenAlex: works by DOI, and their reference lists.
DOI_WORKS = {"10.1/keyword": "W300", "10.1101/2024.05.01.2": "W12"}
REFERENCED = {"W11": ["W300", "W999", "W11"], "W12": ["W11"]}
PREPRINTS = ["doi:10.1101/2024.05.01.1", "doi:10.1101/2024.05.01.2"]


def apis(request: httpx.Request) -> httpx.Response:
    path, params = request.url.path, request.url.params
    if path.endswith("/esearch.fcgi") and params["term"] == "10.1/similar[doi]":
        return httpx.Response(200, json={"esearchresult": {"idlist": ["100"]}})
    if path.endswith("/elink.fcgi") and params["linkname"] == "pubmed_pubmed_refs":
        linksets = [
            {"ids": [pmid], "linksetdbs": [{"linkname": "pubmed_pubmed_refs", "links": REFS.get(pmid, [])}]}
            for pmid in params.get_list("id")
        ]
        return httpx.Response(200, json={"linksets": linksets})
    if request.url.host == "api.openalex.org" and path == "/works":
        field, _, values = params["filter"].partition(":")
        if field == "doi":
            dois = [value.removeprefix("https://doi.org/") for value in values.split("|")]
            works = [{"id": f"https://openalex.org/{DOI_WORKS[d]}", "doi": f"https://doi.org/{d}"}
                     for d in dois if d in DOI_WORKS]
        else:
            works = [{"id": f"https://openalex.org/{w}", "referenced_works": [f"https://openalex.org/{r}"
                     for r in REFERENCED.get(w, [])]} for w in values.split("|")]
        return httpx.Response(200, json={"results": works})
    return fake_apis(request)


@pytest.fixture
def sent(discovery, monkeypatch):
    """Every request sent; OpenAlex has a key here."""
    monkeypatch.setenv("OPENALEX_API_KEY", "test-key")
    monkeypatch.setattr("discovery.sources.openalex._throttle.interval", 0)
    requests: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return apis(request)

    discovery.client = httpx.AsyncClient(transport=httpx.MockTransport(answer))
    return requests


def preprints(discovery) -> None:
    """Two preprints PubMed doesn't have: one OpenAlex record, one known by its DOI only."""
    discovery.store.save(Paper(ids={"openalex": "W11", "doi": PREPRINTS[0].removeprefix("doi:")}, title="One"))
    discovery.store.save(Paper(ids={"doi": PREPRINTS[1].removeprefix("doi:")}, title="Two"))


async def test_pubmed_citations_come_back_under_the_ids_given(discovery, sent):
    # A is pmid:100, given by its DOI; it cites B, B cites C, and D cites nothing in the set.
    result = await citation_links(discovery, ["doi:10.1/similar", "pmid:200", "pmid:300", "pmid:500"])

    assert result == {
        "links": [
            {"from": "doi:10.1/similar", "to": "pmid:200", "source": "pubmed"},
            {"from": "pmid:200", "to": "pmid:300", "source": "pubmed"},
        ],
        "skipped": [],
    }
    # One ELink request for all four papers, and no OpenAlex request: every paper has a PMID.
    [elink] = [r for r in sent if r.url.path.endswith("/elink.fcgi")]
    assert elink.url.params.get_list("id") == ["100", "200", "300", "500"]
    assert not [r for r in sent if r.url.host == "api.openalex.org"]


async def test_papers_without_a_pmid_are_linked_from_openalex(discovery, sent):
    preprints(discovery)

    result = await citation_links(discovery, ["pmid:200", "pmid:300", *PREPRINTS])

    # One cites the PubMed paper pmid:300 (W300 by its DOI), and Two cites One.
    assert result["links"] == [
        {"from": "pmid:200", "to": "pmid:300", "source": "pubmed"},
        {"from": PREPRINTS[0], "to": "pmid:300", "source": "openalex"},
        {"from": PREPRINTS[1], "to": PREPRINTS[0], "source": "openalex"},
    ]
    assert result["skipped"] == []
    # OpenAlex IDs for the papers without one, by DOI; then the preprints' reference lists.
    assert [(r.url.params["filter"], r.url.params["select"]) for r in sent if r.url.host == "api.openalex.org"] == [
        ("doi:https://doi.org/10.1/keyword|https://doi.org/10.1101/2024.05.01.2", "id,doi"),
        ("openalex:W11|W12", "id,referenced_works"),
    ]


async def test_a_failing_openalex_leaves_the_pubmed_links_and_a_note(discovery, sent):
    preprints(discovery)
    discovery.client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda r: httpx.Response(503) if r.url.host == "api.openalex.org" else apis(r)))

    result = await citation_links(discovery, ["pmid:200", "pmid:300", *PREPRINTS])

    assert result["links"] == [{"from": "pmid:200", "to": "pmid:300", "source": "pubmed"}]
    [note] = result["skipped"]
    assert note.startswith("openalex: HTTPStatusError: Server error '503") and "api_key=***" in note


async def test_openalex_reference_lists_are_read_50_works_a_request(discovery, sent):
    works = [f"W{n}" for n in range(1, 121)]
    found = await openalex.references(discovery.client, works)
    assert [len(r.url.params["filter"].removeprefix("openalex:").split("|")) for r in sent] == [50, 50, 20]
    assert found["W11"] == ["W300", "W999", "W11"] and found["W120"] == []


async def test_citation_links_over_mcp(discovery, sent):
    async with Client(build_server(discovery)) as client:
        result = await client.call_tool("citation_links", {"paper_ids": ["pmid:200", "pmid:300", "isbn:1"]})
        assert not result.is_error
        assert result.structured_content["links"] == [{"from": "pmid:200", "to": "pmid:300", "source": "pubmed"}]
        assert [note.split(":")[0] for note in result.structured_content["skipped"]] == ["paper isbn"]

        alone = await client.call_tool("citation_links", {"paper_ids": ["pmid:200", "pmid:200"]})
        assert alone.is_error and "Give 2 to 200 different paper IDs, not 1" in alone.content[0].text
