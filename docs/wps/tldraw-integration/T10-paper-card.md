# T10: Paper card (v4) and PDF reading

| Field | Value |
| --- | --- |
| Lane | Browser |
| Size | L (Phase A, the card: M; Phase B, PDF reading: M) |
| Depends on | T01, T08 (T06 for the tour and lighting up seeds) |
| Unblocks | T12 |
| Milestone | M4 |
| Status | Not started |
| Owner | TBD |

## Goal

Clicking a paper zooms to it, fades everything it isn't linked to, and opens the v4 card beside it: a real figure, the title, one sentence whose claims each show their exact quote on hover, a "Compared with your seeds" strip, and Keep or Discard, all without scrolling. Details opens the evidence, the summary and the notes. The catch-up tour runs inside the same card.

## Context

- **Visual spec:** the [v4 mockup](../../mockups/README.md) (`docs/mockups/flashcard-v4.html`; screenshots `shots-v4/10-click-opens-card.png` and `shots-v4/11-tour.png`). Its design decisions: three layers of detail (node, first view, Details) with a first view that never scrolls; "the board is the picture" (opening a card zooms to the paper and fades what isn't linked); two voices (text from the paper in serif, marked ✓ or ⚠, linking to PubMed; AI text tagged "AI"); real figures only.
- v4 replaced the text-heavy v1 panel (`paper-panel.html`), which the team found too heavy.
- [Concept: Product scope, flows 3 and 5](../../Concept.md#product-scope): the new-paper card, and reading and highlighting a paper together.

## Scope

**Phase A, the card (v4):** opening and closing; zoom and fade; the first view; Details (Evidence, Summary, Notes); Keep and Discard; hover quotes; lighting up seeds; the tour header (with T06).

**Phase B, PDF reading** (in Concept, **not in the v4 mockup**; confirm with the UI owner before building): the PDF with shared highlights, and "Ask about this page / this area" for the agent (T07).

**Out:** where the card's content comes from (the agent fills it through `set_card` and `add_quote`, T02; the discovery service supplies figures, facets and citation counts, [I5](interfaces.md#i5-what-the-board-service-needs-from-the-papers-mcp)).

## Design

**Files** (`client/client/card/`): `PaperCard.tsx`, `FirstView.tsx`, `Details.tsx`, `QuoteHover.tsx`, `FacetStrip.tsx`, `TourHeader.tsx`, `fade.ts`, `connector.tsx`; Phase B in `client/client/reader/`.

**Opening.** Clicking a paper node (`onClick` in `PaperCardShapeUtil` sets `openCardPaperId`, T01), a ranked list row (T09), `_canvas/open_paper` or a tour step (T06). Escape, the close button or clicking empty canvas closes it.

**Zoom and fade ("the board is the picture").**

- Zoom: `editor.zoomToBounds` around the paper and its linked papers, with extra inset on the right so nothing hides behind the card.
- Fade: everything except the paper, the papers it's linked to, those links, and its pinned notes drops to 25 % opacity, in this browser only. Our own shapes read `openCardPaperId`; built-in shapes (arrows, notes, frames) are faded by a generated style rule keyed on the `data-shape-id` attribute tldraw 5.5 puts on every shape wrapper. Nothing is written to the room.
- The links to the open paper show their labels (`cites`, `similar`, a person's own label) while the card is open (T14's hover rule otherwise).

**Placement.** The card docks to the right of the canvas (about 380 px wide), outside the `<Tldraw>` element so its events never reach tldraw, with a dashed connector from the node (positioned with `editor.pageToViewport`) to the card's edge, as in v4.

**First view** (never scrolls):

| Part | Source (card props, T01) |
| --- | --- |
| Figure, "Fig. N · from the paper" | `figure`; none when the paper has no free full text (no placeholder image) |
| Fit and status line ("● High fit · New") | `scores[currentGoal]`, `status` |
| Title | `title` in sentence case |
| "Ibáñez-Molero et al. · Nature · 2026 · cited 24×" | `authors`, `venue`, `year`, `citedBy` |
| One sentence with underlined phrases | `oneLine` and `claims`: hovering a phrase shows its quote (`quotes[id]`) in serif with ✓ (verified) or ⚠ (not found) and a PubMed link with a `#:~:text=` fragment; a phrase whose evidence is `seeds` ("three of your seeds") lights those seeds up on the board (T06 local highlight) |
| "Compared with your seeds" | `facets`: rows Disease, Cells, Method, each a value and ✓ Same, + Adds, Other or Unclear; hovering a row shows its quote |
| Details ⌄, Discard, Keep | Details expands below; votes go to `PUT /vote` (T08), with Undo for a few seconds |

A part whose data hasn't arrived shows a quiet loading line ("Agent is reading…"), and fills in when the agent writes it, live through sync. A part the discovery service can't supply yet (figure, facets, citation count) is left out, not faked.

**Details:**

| Section | Content |
| --- | --- |
| Evidence | Each claim with its quotes and seeds; "Couldn't check" from `gaps` |
| Summary | `summary` next to the original abstract (from `GET /papers/:paperId`, T08), tagged "AI" with model and time |
| Notes | Notes pinned to this paper (T01 `note-pin`), newest first; "Add a note" creates one pinned here |

**Tour header** (with T06). When a tour is running, the card shows a dark header: "CATCH-UP · 1 OF 3", step dots, Previous, Next, Close, and the agent's line for this paper. Keep or Discard records the vote and moves to the next paper; the last step closes the tour and zooms back out.

**AI labels.** "AI" tags show the model and time from the card's provenance: T02 records `{model, at}` for each field `set_card` writes, from the `X-Model` header the harness sends next to `X-Run-Id`.

**Phase B: PDF reading** (if confirmed). "Read the paper" in Details opens a reader over the canvas (a sibling of `<Tldraw>`):

- `pdfjs-dist@6.4.299` from `GET /papers/:paperId/pdf` (T08), pages rendered lazily with pdf.js's text layer; no free PDF: the abstract only.
- Highlights: selecting text offers "Highlight" with an optional note; it creates a `highlight` shape (T01) beside the paper with page, text and page-relative rects; everyone's highlights render in the PDF in their author's colour, with notes and replies.
- Agent highlights (`add_highlight`, T02) are placed by searching their text in the page's text content; misses are listed as not placed.
- "Ask about this page" and "Ask about this area" (drag a box over a figure or table) attach the page or the crop as an image for Super VL, with a caption (T07). The agent can also open pages itself with `look_at_paper` (T07), reusing this reader's loaded document when it's the same paper.

## Tasks

- [ ] Phase A: `client/client/card/` components; `onClick` in `PaperCardShapeUtil`; `fade.ts` (related-shape set and the style rule); connector; Undo on votes; tour header wired to T06.
- [ ] Phase A: T06's `open_paper` handler calls `openCard(paperId)`.
- [ ] Phase B (after confirming scope): `client/package.json` adds `pdfjs-dist@6.4.299`; `client/client/reader/` (PDF view, highlights, ask about page or area).

## Acceptance criteria

1. Clicking a suggestion zooms to it, fades unrelated shapes in this browser only (a second browser is unchanged), and opens the card with figure, fit line, title, byline, one sentence and the facet strip, with no scrolling at 800 px window height.
2. Hovering an underlined phrase shows the verbatim quote in serif with ✓ or ⚠; the link opens PubMed with the sentence highlighted. Hovering "three of your seeds" lights up those seeds on the board.
3. When the agent writes `oneLine` and later `facets` through `set_card`, the open card fills in each part as it arrives, in every browser that has it open.
4. Keep moves the paper to kept for everyone (T08) and offers Undo; during a tour, it moves to the next paper.
5. Details shows Evidence, the AI summary next to the abstract, and the pinned notes; adding a note there pins it to the paper.
6. A paper without a free full text shows no figure, and nothing breaks.
7. Phase B, if built: Ana's highlight appears in Ben's PDF with her name; "Ask about this area" around a figure gets a description of the figure from Super VL.

## Tests

- `client/client/card/fade.test.ts`: the related-shape set (links both ways, pinned notes, hidden links excluded).
- `client/client/card/claims.test.ts`: splitting `oneLine` into phrases by `claims`, unknown quote IDs flagged.
- Manual: the two-browser checks in criteria 1, 3 and 4, recorded for T12.

## Risks

- **Fading built-in shapes per viewer** relies on tldraw's `data-shape-id` attribute; if a tldraw update renames it, the fallback is fading only our own shapes and arrows through an overridden arrow util.
- **Card props arrive in pieces**, so the first view must look intentional while half-empty; v4's loading states are the guide.
- **Phase B scope:** the PDF reader isn't in v4; building it before the card is done risks the demo.

## References

- [v4 mockup and its README](../../mockups/README.md)
- [pdf.js](https://mozilla.github.io/pdf.js/), [text fragments (MDN)](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment/Text_fragments)
- [Concept: Product scope](../../Concept.md#product-scope)
