# T09: Ranked list beside the canvas

| Field | Value |
| --- | --- |
| Lane | Browser |
| Size | S |
| Depends on | T01, T06 (focus), T08 (votes) |
| Unblocks | T12 |
| Milestone | M4 |
| Status | Not started |
| Owner | TBD |

## Goal

The brief's deliverable, always in step with the board: a list of the new papers ranked by fit, each with its metadata, source link and a one-line reason, with Keep and Discard on every row. Clicking a row takes you to the card.

## Context

- The brief asks for "a ranked list of new papers with metadata, source links and relevance explanations" ([Concept: Overview](../../Concept.md#overview)); [Product scope, flow 7](../../Concept.md#product-scope).
- [Architecture diagram 1](../../architecture.html#components): "Ranked list + paper overlay" in the browser.
- Mockup: `docs/mockups/shots/ranked-list.png` ([mockups README](../../mockups/README.md)).
- Decision D11 in the group README: the list is derived from the synced paper cards, not polled.

## Scope

**In:** the list panel; sorting and status filter; rows with metadata, link, reason, working state, votes; focus on click; the legend with the colour key and "Show discarded" (T01's per-viewer visibility).

**Out:** the "Rank for" goal switch (needs per-goal scores from the discovery service); filters that dim cards on the canvas and "Structure by" (stretch, below).

## Design

**Files** (`client/client/ranked/`): `rankedRows.ts` (pure: paper-card shapes to sorted rows), `RankedList.tsx`, `Legend.tsx`.

**Data.** `useValue('paper rows', () => toRows(editor.getCurrentPageShapes()), [editor])`, so the list updates the moment a card is added, rated, voted or edited, by anyone.

| Row field | From the card |
| --- | --- |
| Rank | Position after sorting by `rating` (highest first; unrated last, newest first) |
| Title, authors, venue, year | `title`, `authors`, `venue`, `year` |
| Fit | `fit` badge in the same colours as the cards |
| Why | `reason`, or `tldr` once the reader has run |
| Source | `url`, opened in a new tab |
| State | Working spinner (`working`), status chip, voters' avatars (`keepBy`, `discardBy`) |
| Actions | Keep and Discard (`PUT /vote`, T08), each toggling off if pressed again |

Seeds are excluded by default (they're inputs, not results) and shown with a "Seeds" filter. Status filter: New (default), Kept, Contested, All. Discarded papers appear only under All, greyed.

**Behaviour.** Clicking a row runs T06's local focus on the card and selects it. Up and Down move between rows, Enter focuses, and the list keeps its own keyboard focus so tldraw shortcuts don't fire. The panel docks on the left, collapsible (the chat is on the right); below 900 px wide the two panels become tabs.

**Legend** (top of the list): the fit colours, square for seeds and kept papers, circle for suggestions, badge meanings, and "Show discarded" (per viewer, T01).

**Stretch: per-viewer dimming.** A local atom of filters (status, year range) read by `PaperCardShapeUtil` to render non-matching cards at 25 % opacity. Nothing is written to the room, so each viewer filters independently.

## Tasks

- [ ] `client/client/ranked/rankedRows.ts` with tests.
- [ ] `RankedList.tsx`, `Legend.tsx`; dock in `Room.tsx`.
- [ ] Vote buttons via `client/client/api.ts` (T08).
- [ ] Stretch: dimming atom and `PaperCardShapeUtil` support.

## Acceptance criteria

1. As the agent adds and rates papers, rows appear and re-order live without a reload, in every browser.
2. Each row shows title, authors, venue, year, fit, a reason and a working source link.
3. Keep on a row updates the card and the row's chip and avatars for everyone; pressing it again clears the vote.
4. Clicking a row zooms that viewer to the card and selects it; nobody else's view moves.
5. "Show discarded" in the legend shows and hides discarded cards on the canvas for this viewer only.

## Tests

`client/client/ranked/rankedRows.test.ts`: sorting with ties and nulls, seed exclusion, status filters, discarded handling.

## References

- [tldraw `useValue` and signals](https://tldraw.dev/docs/editor)
- [Concept: Product scope](../../Concept.md#product-scope)
