from pathlib import Path

import pytest

from discovery.papers import Paper, ids_from_url, parse_id
from discovery.sources.pubmed import parse_articles
from discovery.store import Store

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.mark.parametrize(
    ("url", "ids"),
    [
        ("https://pubmed.ncbi.nlm.nih.gov/34290406/", {"pmid": "34290406"}),
        ("https://pmc.ncbi.nlm.nih.gov/articles/PMC9187974/", {"pmcid": "PMC9187974"}),
        ("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9187974", {"pmcid": "PMC9187974"}),
        ("https://arxiv.org/abs/2401.01234v2", {"arxiv": "2401.01234"}),
        (
            "https://www.biorxiv.org/content/10.1101/2023.01.02.522456v1.full",
            {"doi": "10.1101/2023.01.02.522456"},
        ),
        ("https://doi.org/10.1038/S41586-021-03704-Y", {"doi": "10.1038/s41586-021-03704-y"}),
        ("https://www.nature.com/articles/s41586-021-03704-y", {}),
    ],
)
def test_ids_from_url(url, ids):
    assert ids_from_url(url) == ids


def test_parse_id_normalises_and_rejects_unknown_kinds():
    assert parse_id("doi:https://doi.org/10.1038/ABC") == ("doi", "10.1038/abc")
    assert parse_id("pmcid:9187974") == ("pmcid", "PMC9187974")
    with pytest.raises(ValueError, match="Unknown paper ID"):
        parse_id("isbn:123")


def test_pubmed_record_parses_ids_abstract_and_authors():
    (paper,) = parse_articles((FIXTURES / "pubmed_34290406.xml").read_text())
    assert paper.ids == {"pmid": "34290406", "pmcid": "PMC9187974", "doi": "10.1038/s41586-021-03704-y"}
    assert paper.title == "Phenotype, specificity and avidity of antitumour CD8+ T cells in melanoma"
    assert (paper.year, paper.venue, paper.type) == (2021, "Nature", "article")
    assert paper.authors[0] == "Giacomo Oliveira"
    assert paper.abstract.startswith("Interactions between T cell receptors")


def test_store_merges_papers_that_share_an_identifier():
    store = Store()
    first = store.save(Paper(ids={"pmid": "1"}, title="A paper"))
    second = store.save(Paper(ids={"pmid": "1", "doi": "10.1/x"}, title="", abstract="Text"))
    assert first.paper_id == second.paper_id == "pmid:1"
    assert store.get("doi:10.1/X").abstract == "Text"
    assert store.get("doi:10.1/x").title == "A paper"
    assert store.get("pmid:2") is None


def test_summary_shortens_authors_and_abstract():
    paper = Paper(ids={"doi": "10.1/x"}, title="T", authors=list("abcde"), abstract="word " * 200)
    summary = paper.to_summary(["pubmed"])
    assert summary["authors"] == ["a", "b", "c", "et al."]
    assert len(summary["abstract"]) <= 402 and summary["abstract"].endswith("…")
    assert summary["url"] == "https://doi.org/10.1/x"
