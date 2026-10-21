"""Citation counts (`citedBy`) and `peerReviewed` on paper records, from canned OpenAlex and Semantic Scholar data."""

import httpx

from discovery.papers import Paper
from discovery.sources import semantic_scholar
from discovery.sources.openalex import parse_work
from discovery.sources.semantic_scholar import parse_paper
from discovery.store import Store


def work(**extra):
    return {
        "id": "https://openalex.org/W1",
        "ids": {"openalex": "https://openalex.org/W1", "doi": "https://doi.org/10.1/liu"},
        "title": "Temporal single-cell tracing reveals clonal revival",
        "publication_year": 2022,
        "type": "article",
        **extra,
    }


def test_openalex_cited_by_count_is_the_citation_count():
    assert parse_work(work(cited_by_count=122)).cited_by == 122
    # 0 is a count (a new paper nobody has cited yet); a work without the field is unknown
    assert parse_work(work(cited_by_count=0)).cited_by == 0
    assert parse_work(work()).cited_by is None


def test_semantic_scholar_citation_count_is_asked_for_and_kept():
    assert "citationCount" in semantic_scholar.FIELDS.split(",")
    paper = {"paperId": "abc", "title": "T", "externalIds": {"DOI": "10.1/x"}, "citationCount": 86}
    assert parse_paper(paper).cited_by == 86
    assert parse_paper({**paper, "citationCount": None}).cited_by is None


async def test_semantic_scholar_recommendations_carry_citation_counts(monkeypatch):
    monkeypatch.setattr("discovery.sources.semantic_scholar._throttle.interval", 0)
    asked = []

    def api(request: httpx.Request) -> httpx.Response:
        asked.append(request.url.params["fields"])
        paper = {"paperId": "abc", "title": "Recommended", "externalIds": {"DOI": "10.1/r"}, "citationCount": 12}
        return httpx.Response(200, json={"recommendedPapers": [paper]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(api)) as client:
        (paper,) = await semantic_scholar.recommend(client, ["doi:10.1/seed"], [], 5)
    assert "citationCount" in asked[0].split(",")
    assert paper.to_summary(["semantic scholar"])["citedBy"] == 12


def test_records_and_summaries_say_cited_by_and_peer_reviewed():
    paper = parse_work(work(cited_by_count=122))
    record, summary = paper.to_record(), paper.to_summary(["openalex"])
    assert (record["citedBy"], summary["citedBy"]) == (122, 122)
    assert summary["type"] == "article"
    # no source says whether a paper was peer reviewed: a preprint wasn't, anything else is unknown
    assert (record["peerReviewed"], summary["peerReviewed"]) == (None, None)
    preprint = parse_work(work(type="preprint", cited_by_count=0))
    assert preprint.to_record()["peerReviewed"] is False
    assert preprint.to_summary([])["peerReviewed"] is False
    assert Paper(ids={"pmid": "1"}, title="T").to_record()["citedBy"] is None


def test_the_store_keeps_the_count_and_a_zero_is_not_a_gap():
    store = Store()
    store.save(Paper(ids={"pmid": "1"}, title="From PubMed"))
    same = work(ids={"openalex": "W1", "pmid": "https://pubmed.ncbi.nlm.nih.gov/1"}, cited_by_count=5)
    assert store.save(parse_work(same)).cited_by == 5
    assert store.get("pmid:1").to_record()["citedBy"] == 5

    store.save(Paper(ids={"pmid": "2"}, title="Just out", cited_by=0))
    assert store.save(Paper(ids={"pmid": "2"}, title="", cited_by=40)).cited_by == 0
