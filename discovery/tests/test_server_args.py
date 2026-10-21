"""Optional tool arguments over MCP: a placeholder counts as left out, and `since` is checked."""

import json
import re

import httpx
import pytest
from mcp import Client
from test_service import discovery, fake_apis  # noqa: F401 (discovery is a fixture)

from discovery.server import build_server

SEED = "doi:10.1038/s41586-021-03704-y"
ALL_STRATEGIES = ["pubmed_links", "citing", "recommend", "keyword", "web"]


def work(openalex_id: str, title: str, doi: str) -> dict:
    return {"id": f"https://openalex.org/{openalex_id}", "title": title, "doi": f"https://doi.org/{doi}"}


@pytest.fixture
def requests(discovery, monkeypatch):
    """Every request the tools send; OpenAlex and Tavily have keys here and answer too."""
    monkeypatch.setenv("OPENALEX_API_KEY", "test-key")
    monkeypatch.setenv("TAVILY_API_KEY", "test-key")
    monkeypatch.setattr("discovery.sources.openalex._throttle.interval", 0)
    sent: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        if request.url.host == "api.openalex.org" and request.url.path == "/works":
            return httpx.Response(200, json={"results": [work("W2", "OpenAlex hit", "10.1/openalex")]})
        if request.url.host == "api.openalex.org":
            return httpx.Response(200, json=work("W1", "Seed", SEED.removeprefix("doi:")))
        if request.url.host == "api.tavily.com":
            return httpx.Response(200, json={"results": [{"url": "https://pubmed.ncbi.nlm.nih.gov/200/"}]})
        return fake_apis(request)

    discovery.client = httpx.AsyncClient(transport=httpx.MockTransport(answer))
    return sent


def start_dates(sent: list[httpx.Request]) -> dict[str, list[str | None]]:
    """The start date each source's searches were sent, None for a search without one."""
    dates: dict[str, list[str | None]] = {"pubmed": [], "openalex": [], "web": []}
    for request in sent:
        params = request.url.params
        # ID lookups such as `10.1/x[doi]` never take a date.
        if request.url.path.endswith("/esearch.fcgi") and not params["term"].endswith("]"):
            dates["pubmed"].append(params.get("mindate"))
        elif request.url.host == "api.openalex.org" and request.url.path == "/works":
            match = re.search(r"from_publication_date:([^,]+)", params.get("filter", ""))
            dates["openalex"].append(match and match[1])
        elif request.url.host == "api.tavily.com":
            dates["web"].append(json.loads(request.content).get("start_date"))
    return dates


async def test_a_placeholder_since_reaches_every_source_unset(discovery, requests):
    async with Client(build_server(discovery)) as client:
        result = await client.call_tool("search", {"query": "melanoma", "since": "None", "sources": "None"})

    assert not result.is_error
    assert result.structured_content["countsBySource"] == {"pubmed": 2, "openalex": 1, "web": 1}
    assert result.structured_content["skipped"] == []
    assert start_dates(requests) == {"pubmed": [None], "openalex": [None], "web": [None]}


async def test_find_candidates_with_placeholders_runs_every_strategy(discovery, requests):
    arguments = {
        "seed_ids": [SEED], "exclude_ids": "None", "since": "null", "strategies": ALL_STRATEGIES,
        "query": "melanoma",
    }
    async with Client(build_server(discovery)) as client:
        result = await client.call_tool("find_candidates", arguments)

    assert not result.is_error
    assert list(result.structured_content["countsByStrategy"]) == ALL_STRATEGIES
    assert result.structured_content["skipped"] == []
    citing = [r for r in requests if "cites:" in r.url.params.get("filter", "")]
    assert [r.url.params["filter"] for r in citing] == ["cites:W1"]
    # OpenAlex is asked twice: for the papers citing the seed and for the keyword search.
    assert start_dates(requests) == {"pubmed": [None], "openalex": [None, None], "web": [None]}


async def test_the_service_reads_a_placeholder_since_as_unset(discovery, requests):
    # Direct Python callers skip the MCP validation; _pubmed_links used to crash on int("None").
    result = await discovery.find_candidates([SEED], strategies=["pubmed_links"], since="None")
    assert result["countsByStrategy"] == {"pubmed_links": 3} and result["skipped"] == []


@pytest.mark.parametrize(
    "since, start", [("2020", "2020-01-01"), ("2020-05", "2020-05-01"), ("2020-05-01", "2020-05-01")]
)
async def test_since_takes_a_year_a_month_or_a_day(discovery, requests, since, start):
    async with Client(build_server(discovery)) as client:
        result = await client.call_tool("search", {"query": "melanoma", "since": since})

    assert not result.is_error and result.structured_content["skipped"] == []
    # OpenAlex and Tavily take full dates only, so a year or a month starts on its first day.
    assert start_dates(requests) == {"pubmed": [start.replace("-", "/")], "openalex": [start], "web": [start]}


async def test_since_in_words_is_refused_with_the_formats(discovery, requests):
    async with Client(build_server(discovery)) as client:
        for tool, arguments in [("search", {"query": "melanoma"}), ("find_candidates", {"seed_ids": [SEED]})]:
            result = await client.call_tool(tool, {**arguments, "since": "last year"})
            assert result.is_error
            assert "since must be YYYY, YYYY-MM or YYYY-MM-DD" in result.content[0].text
    assert requests == []

    with pytest.raises(ValueError, match="since must be YYYY, YYYY-MM or YYYY-MM-DD"):
        await discovery.search("melanoma", since="2020/05")


async def test_other_optional_arguments_take_placeholders_too(discovery, requests):
    async with Client(build_server(discovery)) as client:
        seed = await client.call_tool(
            "resolve_seed", {"doi": SEED.removeprefix("doi:"), "pmid": "None", "title": "undefined"}
        )
        assert not seed.is_error and seed.structured_content["paperId"] == SEED

        ranked = await client.call_tool(
            "rerank",
            {"goal": "T cells", "paper_ids": [], "seed_ids": "None", "exclude_ids": "NULL", "backend": ""},
        )
        assert not ranked.is_error
        assert ranked.structured_content["skipped"] == ["no candidates to rank"]
