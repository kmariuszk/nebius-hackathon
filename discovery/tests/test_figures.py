"""Figure image URLs from the PMC article page, and `get_figures` (no network)."""

from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from mcp import Client
from test_service import FILLER, article, discovery, fake_apis  # noqa: F401 (discovery is a fixture)

from discovery import figures
from discovery.fulltext import Figure, FullText, Section
from discovery.server import build_server

PMID, PMCID = "27124452", "PMC4944528"
PAGE = (Path(__file__).parent / "fixtures" / f"pmc_{PMCID}.html").read_text()
BLOCK = "<html><body><p>Your access to PMC has been limited. Try again later.</p></body></html>"
CDN = "https://cdn.ncbi.nlm.nih.gov/pmc/blobs/c11f/4944528"
F1 = f"{CDN}/1f7a6569b280/nihms791837f1.jpg"
F2 = f"{CDN}/48328c626293/nihms791837f2.jpg"

ARTICLE = article(PMID, "Dissecting the multicellular ecosystem of metastatic melanoma").replace(
    "</ArticleIdList>", f'<ArticleId IdType="pmc">{PMCID}</ArticleId></ArticleIdList>'
)
# F1 matches the page by ID; fig2 only by its image file; F3 isn't on the (trimmed) page.
JATS = f"""<pmc-articleset><article xmlns:xlink="http://www.w3.org/1999/xlink"><front/><body>
<sec><title>Results</title><p>{FILLER}</p><p>{FILLER}</p>
<fig id="F1"><label>Figure 1</label><caption><title>Dissection of melanoma with single-cell RNA-seq.</title>
<p>(A) Overview of workflow.</p></caption><graphic xlink:href="nihms791837f1"/></fig>
<fig id="fig2"><label>Figure 2</label><caption><p>Cell cycle states.</p></caption>
<alternatives><graphic xlink:href="nihms791837f2.jpg"/></alternatives></fig>
<fig id="F3"><label>Figure 3</label><caption><p>MITF and AXL programs.</p></caption>
<graphic xlink:href="nihms791837f3"/></fig></sec>
</body></article></pmc-articleset>"""


@pytest.fixture
def page(discovery, monkeypatch):
    """The article page's answers, in order, the last one repeating; `fetched` counts the requests."""
    monkeypatch.setattr(figures, "RETRY_SECONDS", 0)
    state = SimpleNamespace(answers=[PAGE], fetched=0)

    def answer(request: httpx.Request) -> httpx.Response:
        path, params = request.url.path, request.url.params
        if request.url.host == "pmc.ncbi.nlm.nih.gov" and path == f"/articles/{PMCID}/":
            state.fetched += 1
            return httpx.Response(200, text=state.answers[min(state.fetched, len(state.answers)) - 1])
        if path.endswith("/esearch.fcgi") and params["term"] == f"{PMCID}[pmcid]":
            return httpx.Response(200, json={"esearchresult": {"idlist": [PMID]}})
        if path.endswith("/efetch.fcgi") and params["id"] == PMCID:
            return httpx.Response(200, text=JATS)
        if path.endswith("/efetch.fcgi") and params["id"] == PMID:
            return httpx.Response(200, text=f"<PubmedArticleSet>{ARTICLE}</PubmedArticleSet>")
        return fake_apis(request)

    discovery.client = httpx.AsyncClient(transport=httpx.MockTransport(answer))
    return state


def test_the_article_page_gives_each_figures_image_by_id_and_by_file():
    urls = figures.parse_page(PAGE)
    assert urls == {"F1": F1, "nihms791837f1": F1, "F2": F2, "nihms791837f2": F2}  # no logo: it's no figure
    assert figures.stem("pone.0123456.g001.tif") == "pone.0123456.g001"


async def test_get_figures_gives_labels_captions_and_image_urls(discovery, page):
    result = await discovery.get_figures(f"pmcid:{PMCID}")

    assert result == {
        "paperId": f"pmid:{PMID}",
        "source": "pmc",
        "figures": [
            {"figureId": "F1", "label": "Figure 1", "imageUrl": F1,
             "caption": "Dissection of melanoma with single-cell RNA-seq. (A) Overview of workflow."},
            {"figureId": "fig2", "label": "Figure 2", "caption": "Cell cycle states.", "imageUrl": F2},
            {"figureId": "F3", "label": "Figure 3", "caption": "MITF and AXL programs.", "imageUrl": None},
        ],
        "skipped": [],
    }
    # get_fulltext reads the same cached text, so the page was fetched once.
    text = await discovery.get_fulltext(f"pmcid:{PMCID}")
    assert [f["imageUrl"] for f in text["figures"]] == [F1, F2, None] and "graphic" not in text["figures"][0]
    assert page.fetched == 1


async def test_a_block_page_twice_then_the_article_still_gives_the_urls(discovery, page):
    page.answers = [BLOCK, BLOCK, PAGE]
    result = await discovery.get_figures(f"pmcid:{PMCID}")
    assert [f["imageUrl"] for f in result["figures"]] == [F1, F2, None] and result["skipped"] == []
    assert page.fetched == 3


async def test_a_block_page_three_times_gives_figures_without_urls_and_says_why(discovery, page):
    page.answers = [BLOCK]
    result = await discovery.get_figures(f"pmcid:{PMCID}")
    assert [f["label"] for f in result["figures"]] == ["Figure 1", "Figure 2", "Figure 3"]
    assert [f["imageUrl"] for f in result["figures"]] == [None, None, None]
    assert result["skipped"] == ["figure images: PMC's article page was a block page 3 times"]
    assert page.fetched == 3

    # A block page may pass: the next read tries again.
    again = await discovery.get_figures(f"pmcid:{PMCID}")
    assert again["skipped"] == result["skipped"] and page.fetched == 6


async def test_a_text_cached_before_image_urls_gets_them_once(discovery, page):
    paper = await discovery.get_paper(f"pmcid:{PMCID}")
    url = f"https://pmc.ncbi.nlm.nih.gov/articles/{PMCID}/"
    old = {"source": "pmc", "url": url, "sections": [{"title": "Results", "text": FILLER}],
           "figures": [{"figureId": "F2", "label": "Figure 2", "caption": "Cell cycle states."}]}
    discovery.store.save_fulltext(paper.paper_id, FullText.from_record(old))

    result = await discovery.get_figures(paper.paper_id)

    assert result["figures"][0]["imageUrl"] == F2 and page.fetched == 1
    assert discovery.store.get_fulltext(paper.paper_id).figures == [
        Figure("F2", "Figure 2", "Cell cycle states.", imageUrl=F2)
    ]
    await discovery.check_quotes(paper.paper_id, ["Exhausted CD8 T cells lose effector function"])
    assert page.fetched == 1


async def test_get_figures_for_a_paper_without_pmc_full_text(discovery):
    discovery.store.save_fulltext(
        (await discovery.get_paper("pmid:100")).paper_id,
        FullText("web", "https://doi.org/10.1/similar", [Section("Main text", FILLER)]),
    )
    result = await discovery.get_figures("pmid:100")
    assert result["source"] == "web" and result["figures"] == []
    assert result["skipped"] == ["figures come from PMC only, and there is no PMC full text for this paper"]


async def test_get_figures_over_mcp(discovery, page):
    async with Client(build_server(discovery)) as client:
        result = await client.call_tool("get_figures", {"paper_id": f"pmcid:{PMCID}"})
    assert not result.is_error
    assert result.structured_content["figures"][0]["imageUrl"] == F1
