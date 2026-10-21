# D05: Real figures on the card

| Field | Value |
| --- | --- |
| Lane | Discovery + Harness |
| Size | M |
| Priority | P1 |
| Depends on | — ([T10 refresh](../tldraw-integration/T10-paper-card.md) shows "No free figure" when there is none) |
| Unblocks | The figure widget and ranked-list thumbnails on a real board; [T07 refresh](../tldraw-integration/T07-board-context.md)'s `look_at_figure` |
| Milestone | W2 One clean run |
| Status | Built on branch `w2/figures` (Oct 21); criteria 4 and 5 wait for the live check and a browser look |
| Owner | TBD |

## Goal

A paper with a free full text in PubMed Central shows a real figure from it in the opened paper's figure widget and as its ranked-list thumbnail: the figure the reader judged most important, with its label and caption. Papers without one show no figure, never a placeholder that waits forever.

## Context

- Finding F19: no figure ever reaches a real card. `get_fulltext` lists PMC figures by `figureId`, label and caption (`discovery/discovery/fulltext.py`, `from_jats`), and the reader already picks up to two of them by caption, but there is no image URL, and the canvas MCP's `set_card` takes a figure only with an `https` `imageUrl` ([harness README: not built yet](../../../harness/README.md)).
- PMC's JATS XML names a figure's image file (`<graphic xlink:href="nihms791837f1">`) but not where it's served: the CDN path has hash folders (`https://cdn.ncbi.nlm.nih.gov/pmc/blobs/c11f/4944528/1f7a6569b280/nihms791837f1.jpg`). The article page does have it: on `https://pmc.ncbi.nlm.nih.gov/articles/PMC4944528/`, each `<figure id="F1">` holds an `<img src>` with that full URL, and the JATS `fig id` is the same `F1` (checked Oct 20).
- The v4 mockup notes: PMC's article page "sometimes returns a small block page instead, so retry slowly" ([mockups README](../../mockups/README.md), "Things we found while building it"). The figure widget and list thumbnail are built (`client/client/widgets/parts.tsx` `FigureWidget`, `pinboard/RankedList.tsx`).

## Scope

**In:** image URLs for PMC figures; a `get_figures` tool; the background writing the reader's pick to the card.

**Out:** figures from publisher pages or preprints; Super VL looking at the images to choose (it picks by caption); a figure per goal ([I9](../tldraw-integration/interfaces.md#i9-discovery-data-the-v5-widgets-show)'s "the figure picked per goal" stays later work).

## Design

**Discovery:**

- `Figure` gains `imageUrl: str | None = None` and `graphic: str | None = None` (the JATS file name). `from_jats` fills `graphic` from the `<graphic>` inside each `<fig>`.
- `pubmed.pmc_figure_urls(client, pmcid) -> dict[str, str]`: `GET https://pmc.ncbi.nlm.nih.gov/articles/<pmcid>/` with the service's user agent; parse each `<figure … id="X">` and the first `<img src>` inside it on `cdn.ncbi.nlm.nih.gov`; return `{figure id: url}`, plus `{file stem: url}` for matching by `graphic`. A page with no `<figure` is treated as a block page: retry twice, 2 s apart, then give up with a `Skipped` reason.
- `Discovery._fulltext` fills `imageUrl` for PMC full text right after `from_jats` (matching by `figureId`, then by `graphic` stem) and caches the result as today. A cached full text whose figures all lack `imageUrl` gets them filled once on the next read, and is saved again.
- **`get_figures(paper_id)`** (tool in `server.py`): `{paperId, source, figures: [{figureId, label, caption, imageUrl}], skipped}`, from the same cached full text, so the background can fetch figures without the whole text. `get_fulltext`'s `figures` gain `imageUrl` too.

**Harness** (`harness/harness/agents/master/background.py`, `write_reading`): after the quotes and summary, if the reading's `figures` has a pick, call `get_figures(paper_id)` (in the same `Step`, with `board.papers("get_paper", "get_figures")`), take the reader's first pick whose `figureId` has an `imageUrl` and call `set_card` with `figure: {imageUrl, label, caption: caption[:1500], captionByAi: false}`. No pick with an image, no figure. A failed `get_figures` is logged and leaves the card without a figure; it never becomes a gap.

## Tasks

- [x] `discovery/discovery/fulltext.py`: `Figure.imageUrl`, `Figure.graphic`, `from_jats` reads `graphic`; `from_record` defaults both to `None`.
- [x] `discovery/discovery/sources/pubmed.py`: `pmc_figure_urls` with the block-page retry. Built as `page_urls` and `parse_page` in a new `discovery/discovery/figures.py`, with the fill step (`add_image_urls`), since the article page isn't E-utilities.
- [x] `discovery/discovery/service.py`: fill `imageUrl` in `_fulltext`; `get_figures`; `server.py`: the tool. A lookup that found no image keeps its reason with the cached text (`FullText.imagesSkipped`, which `get_figures` reports in `skipped`), so only texts cached before D05 are filled again, once.
- [x] `discovery/tests/fixtures/pmc_PMC4944528.html`: the article page trimmed to two `<figure>` blocks; tests in `test_papers.py` or a new `test_figures.py`.
- [x] `harness/harness/agents/master/background.py`: the figure write; `harness/tests/test_master_board.py`. Tests in a new `harness/tests/test_figures_write.py`.
- [x] `discovery/README.md`, `harness/README.md` (remove "Figures on the card" from "Not built yet"), [interfaces.md I5 and I9](../tldraw-integration/interfaces.md#i5-what-the-board-service-needs-from-the-papers-mcp).

## Acceptance criteria

1. Parsing the fixture page gives `F1` → `https://cdn.ncbi.nlm.nih.gov/pmc/blobs/c11f/4944528/1f7a6569b280/nihms791837f1.jpg`, and `F2` likewise.
2. `get_figures("pmcid:PMC4944528")` (with the canned efetch and page) returns figures with labels, captions and image URLs; a block page twice then a real page still gives the URLs; a block page three times gives figures without URLs and a `skipped` reason.
3. A scripted background read whose reader picks `F2` writes `set_card` with that figure's URL, label and caption and `captionByAi: false`; a pick without a URL writes no figure.
4. In [H01](../agent-harness/H01-live-board-check.md) on the five demo seeds, at least half of the suggestions with a PMC full text have a figure, and every figure URL loads (HTTP 200, an image content type).
5. In the browser, those papers show the figure in the opened paper and as the ranked-list thumbnail.

## Tests

- Discovery: criteria 1 and 2 with `fake_apis` extended for the article page.
- Harness: criterion 3 with the scripted reader answer and a stand-in papers MCP that lists `get_figures`.

## Risks

- **PMC blocks or changes its page:** retries, caching and a hidden figure on failure; the parser is one function with a fixture test, so a markup change is a one-line fix.
- **Hot-linking the CDN from the browser:** the images are public and the mockups already load them this way; if PMC starts refusing other origins, proxy them like PDFs (`client/server/pdfProxy.ts`).

## References

- [PMC article page for PMC4944528](https://pmc.ncbi.nlm.nih.gov/articles/PMC4944528/)
- [interfaces.md I9: discovery data the widgets show](../tldraw-integration/interfaces.md#i9-discovery-data-the-v5-widgets-show)
