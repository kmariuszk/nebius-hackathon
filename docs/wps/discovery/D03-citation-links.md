# D03: Citation links between board papers

| Field | Value |
| --- | --- |
| Lane | Discovery + Harness + Board |
| Size | M |
| Priority | P1 |
| Depends on | — ([T15](../tldraw-integration/T15-graph-layout-and-strings.md) makes the card note count only these links) |
| Unblocks | The red strings and "cites N of your seeds" on a real board; [D04](D04-clusters-from-data.md)'s optional citation blend |
| Milestone | W2 One clean run |
| Status | Built on `w2/citations` (Oct 21). Criterion 4 holds in part: in the Wave 2 live runs on `w2/integration` (Oct 21, Super VL, cold cache, five demo seeds; 5 completed, 1 hung on a Lightning outage), each board had 14 to 23 cites links with no model `link_papers` call; the PubMed spot check of three links is still to do. Criterion 5 needs a browser look |
| Owner | TBD |

## Goal

Whenever the agent places papers, the board draws a red `cites` string for every citation between two papers on it, taken from PubMed (or OpenAlex for papers PubMed doesn't have), with no model involved. The top card's "cites 3 of your seeds" is then a fact a judge can check on PubMed.

## Context

- Finding F8 (Oct 19): the live board had 38 links, all `similar` (the context agent's judgement); nothing makes `cites` links, yet the card's red note said "cites N of your seeds", counting `similar` links. The v6 design draws cites as red strings and calls them "a PubMed fact" ([mockups README](../../mockups/README.md), "Three kinds of link").
- The papers MCP already reads PubMed's links for candidates (`pubmed.elink` with `pubmed_pubmed_refs` and `pubmed_pubmed_citedin` in `_pubmed_links`) and OpenAlex's citing works (`openalex.citing`), but has no tool that answers "which of these papers cite each other".
- The canvas MCP's `link_papers` already supports kind `cites` (arrow from the citing paper) and writes `meta.by = "pubmed"` for it (`client/server/canvasTools.ts`).

## Scope

**In:** the `citation_links` tool; an optional `source` on `link_papers`; a model-free harness step that links the board's papers after each placement.

**Out:** the card note's wording (T15); citation links to papers that aren't on the board; using citations in scoring or clustering (open questions in the [group README](README.md#open-questions)).

## Design

**`citation_links(paper_ids)`** (`discovery/discovery/service.py`, tool in `server.py`), 2 to 200 IDs:

1. Load the records (`self._papers(paper_ids, "paper")`); a paper that can't be loaded goes in `skipped`.
2. Map every alias of every paper (`paper.aliases()`) to the ID it was given as, so a link comes back under the caller's IDs.
3. PubMed: for the papers with a PMID, `pubmed.elink(pmids, pubmed.REFERENCES)` gives each paper's references; each referenced PMID that maps to another paper in the set is a link `{from: citing, to: cited, source: "pubmed"}`.
4. OpenAlex: for the papers without a PMID that have an OpenAlex ID (or a DOI that `openalex.work` resolves), a new helper `openalex.references(client, work_ids)` fetches `referenced_works` (`/works?filter=openalex:W1|W2…&select=id,referenced_works`, 50 IDs per request); each referenced work that maps to a paper in the set is a link with `source: "openalex"`.
5. Deduplicate by `(from, to)`, PubMed first; drop self-links. Return `{links, skipped}`.

A source that fails (no key, an HTTP error) is a `skipped` note, as everywhere in the papers MCP.

**`link_papers` gains `source`** (`client/server/canvasTools.ts`): each link may carry `source: "pubmed" | "openalex"`; it sets the arrow's `meta.by` (default `pubmed` for `cites`, `agent` for `similar`, as today). The tool description says so.

**The harness step** (`harness/harness/agents/master/background.py`, step 1 of the [after-placement steps](../agent-harness/README.md#shared-contracts)): `ProcessPapers.link_citations()` runs a `Step` named `citations` with `board.canvas("get_board", "link_papers")` and `board.papers("citation_links")`:

1. `get_board` → every paper ID on the board (seeds, kept and suggestions).
2. If the papers MCP doesn't list `citation_links`, stop (hidden, not faked).
3. `citation_links(paper_ids)` → links.
4. `link_papers(links=[{from, to, kind: "cites", source}])` in chunks of 100; links people removed or hid are skipped by the canvas, as today.

It runs once per master turn that placed papers (from `after_turn` and from `process_papers`, whichever comes first, guarded by a per-turn flag), before the reading starts, so the strings appear while the cards are still "Reading…".

## Tasks

- [x] `discovery/discovery/sources/openalex.py`: `references(client, work_ids)`, and `by_doi(client, dois)` for the OpenAlex IDs of board papers that came from PubMed, so a preprint's references to them are found.
- [x] `citation_links` in its own module, `discovery/discovery/citations.py` (not `service.py`); `server.py`: the tool and its docstring.
- [x] `discovery/tests/test_citations.py`: canned `elink` and OpenAlex payloads.
- [x] `client/server/canvasTools.ts`: `source` on `link_papers`; `canvasTools.test.ts`.
- [x] `harness/harness/agents/master/background.py`: `link_citations` and its calls from `batch` and, for a turn that placed only seeds, `after_turn`; `harness/tests/test_citations_step.py`.
- [x] `discovery/README.md` (tools table), [interfaces.md I5](../tldraw-integration/interfaces.md#i5-what-the-board-service-needs-from-the-papers-mcp) row.

## Acceptance criteria

1. With canned PubMed links where A cites B and B cites C, `citation_links([A, B, C, D])` returns exactly A→B and B→C with `source: "pubmed"`, under the IDs given (a DOI given for a PubMed paper comes back as that DOI).
2. A paper without a PMID that OpenAlex says references another paper in the set gives a link with `source: "openalex"`; a failing OpenAlex call leaves the PubMed links and a `skipped` note.
3. A scripted master turn that places papers makes one `citation_links` call and one `link_papers` call with kind `cites`, and the model makes no `link_papers` call for them.
4. In [H01](../agent-harness/H01-live-board-check.md) on the five demo seeds, the board has at least 3 cites links; three of them, picked at random, check out on PubMed (the citing paper's reference list has the cited one).
5. With [T15](../tldraw-integration/T15-graph-layout-and-strings.md) merged, the top new card's note "cites N of your seeds" matches its cites links to seeds.

## Tests

- Discovery: criteria 1 and 2 with `fake_apis` (`discovery/tests/test_service.py`).
- Board: `link_papers` with `source: "openalex"` writes `meta.by = "openalex"`.
- Harness: criterion 3 with the scripted model, a stand-in papers MCP that lists `citation_links`, and `fake_canvas.py`.

## Risks

- **Many board papers are DOIs without PMIDs** (bioRxiv, some journals): OpenAlex covers them, with its budget risk (`OPENALEX_API_KEY` is in SecretStash).
- **Reference lists are incomplete in PubMed for recent papers:** fewer strings, never wrong ones; the card note only counts what's there.

## References

- [PubMed E-utilities ELink](https://www.ncbi.nlm.nih.gov/books/NBK25499/#chapter4.ELink)
- [OpenAlex works: referenced_works](https://docs.openalex.org/api-entities/works/work-object#referenced_works)
- [Agent harness: after-placement steps](../agent-harness/README.md#shared-contracts)
