"""What add_papers takes from discovery's paper records: the citation count among the card's fields."""

from harness.agents.master import candidates

RANKED = {"structuredContent": {"ranked": [
    {"paperId": "doi:10.1/liu", "title": "Clonal revival", "year": 2022, "type": "article", "citedBy": 122,
     "peerReviewed": None, "abstract": "…", "rank": 1, "score": 0.9, "reason": "Same cells."},
    {"paperId": "doi:10.1101/new", "title": "Just out", "type": "preprint", "citedBy": 0, "peerReviewed": False},
    {"paperId": "pmid:3", "title": "From PubMed", "citedBy": None},
]}}


def test_card_details_keep_the_citation_count_even_when_it_is_zero():
    assert candidates.details("rerank", RANKED) == [
        {"paperId": "doi:10.1/liu", "title": "Clonal revival", "year": 2022, "type": "article", "citedBy": 122},
        {"paperId": "doi:10.1101/new", "title": "Just out", "type": "preprint", "citedBy": 0},
        {"paperId": "pmid:3", "title": "From PubMed"},
    ]


def test_add_papers_gets_the_citation_count_the_tools_returned():
    papers = {paper["paperId"]: paper for paper in candidates.details("rerank", RANKED)}
    args = {"papers": [{"paperId": "doi:10.1/liu", "near": "pmid:9", "citedBy": 5000},
                       {"paperId": "doi:10.1101/new", "near": "pmid:9"}]}
    assert candidates.fill_cards(args, papers, set()) is None
    assert args["papers"] == [
        {"paperId": "doi:10.1/liu", "near": "pmid:9", "title": "Clonal revival", "year": 2022, "type": "article",
         "citedBy": 122},
        {"paperId": "doi:10.1101/new", "near": "pmid:9", "title": "Just out", "type": "preprint", "citedBy": 0},
    ]
