# T10: Paper overlay with PDF and shared highlights

| Field | Value |
| --- | --- |
| Lane | Browser |
| Size | L (two phases, each M) |
| Depends on | T01, T08 (T06 for `_canvas/open_paper`) |
| Unblocks | T12 |
| Milestone | M4 |
| Status | Not started |
| Owner | TBD |

## Goal

Clicking a paper zooms to its card and opens the paper above the canvas: what it is, why it matters with its evidence, what couldn't be checked, where it sits on the board, and the PDF itself. A passage a researcher highlights there appears live for every collaborator, in the PDF with their name and on the board as a node linked to the paper.

## Context

- [Concept: Product scope, flows 3 and 5](../../Concept.md#product-scope): the overlay's sections and order, and shared highlighting.
- The clickable mockup and its section order: [`docs/mockups/paper-panel.html`](../../mockups/paper-panel.html), described in the [mockups README](../../mockups/README.md); the README notes Concept has since turned the fixed panel into an overlay with the PDF.
- [Concept: Risks](../../Concept.md#requirements-risks-and-first-hour-checklist), "PDF highlighting in the overlay": render pdf.js outside tldraw's event handling; anchor agent highlights by searching the quote in the text layer.

## Scope

**Phase A (M), overlay shell:** opening and closing; the sections from data that exists; the pinned buttons.

**Phase B (M), PDF and highlights:** pdf.js with a text layer; making highlights; rendering everyone's highlights; notes and replies; placing agent highlights by text.

**Out:** figures (wait for `get_figures`, [I5](interfaces.md#i5-what-the-board-service-needs-from-the-papers-mcp)); the agent categorising highlights (harness owner; it would use a canvas MCP tool added to T02 then); highlighting the abstract when there is no PDF (later).

## Design

**Files** (`client/client/overlay/`): `overlayStore.ts` (`openPaper(paperId)`, `closePaper()`, a local atom), `PaperOverlay.tsx`, one component per section, `PdfView.tsx`, `highlights.ts` (selection to rects, text anchoring, colours).

**Opening.** Double-clicking a `paper-card` (`onDoubleClick` in its `ShapeUtil`), "Open" on a ranked list row, or `_canvas/open_paper` from the agent (T06). Each first focuses the card (T06), then opens. Escape or the close button closes it. The overlay is a sibling of the `<Tldraw>` element, positioned over the canvas area, so pointer and keyboard events inside it never reach tldraw.

**Phase A: sections**, in the mockup's order. A section whose data doesn't exist yet is hidden, not faked:

| Section | Source |
| --- | --- |
| What it is: title, authors, venue, year, DOI, PubMed and PDF links, type | `GET /papers/:paperId` (T08), which merges `get_paper` |
| Why it matters, relation tag | Card `whyItMatters` and `reason` (live from the store); numbered claims once the discovery service sends `relevance.claims` |
| Evidence: quotes with "exact match" or "not found", seeds it cites | `quote` shapes for this paper (live); citations from the record when present |
| Couldn't check | `relevance.gaps` when present |
| On this board: cluster, links, how it was found | Arrows bound to the card; cluster frame; `foundBy` from the record |
| AI summary next to the original abstract, notes | Card `summary` and `tldr`; record `abstract`; notes linked to the card |
| Pinned buttons | Discard and Keep (`PUT /vote`, T08); Ask agent (selects the card and focuses the chat input, so T07 attaches it); Dig deeper (sends "Find related work around this paper" with the card attached) |

Text taken from the paper is set in serif and links to its source; AI-written text carries an "AI" tag with its model and time when the record has them.

**Phase B: PDF.** `pdfjs-dist@6.4.299`, the worker loaded with Vite's `?url` import, from `GET /papers/:paperId/pdf` (T08). Pages render lazily as they scroll into view, each with pdf.js's text layer so text can be selected. No open-access PDF: "No open-access PDF; summary from the abstract", plus the abstract.

**Making a highlight.**

1. Selecting text in the text layer shows a small "Highlight" button with an optional note field.
2. On confirm, `highlights.ts` turns the selection's client rects into page-relative rects (0 to 1) and records the page number and exact text.
3. The browser creates a `highlight` shape (T01) beside the paper card, stacked below earlier highlights, with `meta.author = memberId`, and an arrow bound to the card. Being a person's shape, it is synced like any edit and never touched by agents.

**Rendering highlights.** `useValue` over `highlight` shapes with this `paperId` draws each one's rects over its page: colour from the category when set, else from the author (a stable colour from the member ID); hovering shows the author's name and the note. Notes and replies are edited in a side list in the overlay (`replies` append `{author, text, at}`), and appear live for everyone.

**Agent highlights** (from T02's `add_highlight`, which has text and maybe a page but no rects): the overlay searches the page's text content (or every page if no page is given) for the text, whitespace-normalised, and draws the match. Not found: listed under "Couldn't place in the PDF".

**Asking about what's on the page** (with [T07](T07-board-context.md)). Super VL reads figures, drawings, charts and tables from a picture of the page, beyond what OCR or the text layer gives. Two controls on the PDF toolbar:

- **Ask about this page:** attaches the current page, rendered by pdf.js, as an image with the caption "Page N of <first author year> (<paperId>)", and focuses the chat input.
- **Ask about this area:** the researcher drags a box over a figure or table; only that crop is attached (at up to 1,600 px on the long side), captioned with the page.

The agent can also open pages itself with `look_at_paper` (T07); when this overlay has the same paper open, the snapshot renderer reuses its loaded document.

## Tasks

- [ ] Phase A: `overlayStore.ts`, `PaperOverlay.tsx`, sections, buttons; `onDoubleClick` in `PaperCardShapeUtil`; T06's `open_paper` handler calls `openPaper`.
- [ ] Phase B: `client/package.json` adds `pdfjs-dist@6.4.299`; `PdfView.tsx`; `highlights.ts` with tests; highlight creation and rendering; side list for notes and replies; "Ask about this page" and "Ask about this area" (crop to PNG, handed to T07's prompt builder).

## Acceptance criteria

1. Double-clicking a card zooms to it and opens the overlay with title, authors, venue, year, links and the AI summary next to the abstract; sections without data are absent.
2. Keep in the overlay updates the card for everyone (T08).
3. Ana highlights a sentence with a note; Ben, with the same paper open, sees it appear in his PDF with Ana's name, and both see a highlight node linked to the card.
4. Ben replies to Ana's note; Ana sees the reply live.
5. An agent highlight whose text is in the PDF is drawn on the right page; one whose text isn't is listed as not placed.
6. "Ask about this area" around a figure, then "what does this show?", gets a description of the figure's content (panels, axes, what is plotted or drawn) from Super VL.
7. Selecting text and pressing Delete or letters inside the overlay never changes the canvas.

## Tests

- `client/client/overlay/highlights.test.ts`: rect normalisation and back; text anchoring with whitespace and hyphenation differences; colour stability.
- Manual: the two-browser checks in criteria 3 and 4, recorded for T12.

## Risks

- **Text layer quirks** (ligatures, hyphenation, two-column layouts) make agent text anchoring miss: normalise whitespace and hyphens; misses are listed, not drawn wrong.
- **Large PDFs:** lazy page rendering and the 50 MB cap in T08's proxy.
- **Scope:** this is the largest WP; Phase A alone already meets the demo's "open a paper" beat, so Phase B can follow.

## References

- [pdf.js](https://mozilla.github.io/pdf.js/)
- [Text fragments (MDN)](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment/Text_fragments), used by quote links
- [Concept: Product scope](../../Concept.md#product-scope)
