# T09: Ranked list, filters and "Looking for"

| Field | Value |
| --- | --- |
| Lane | Browser |
| Size | M |
| Depends on | T01, T06 (focus), T08 (votes) |
| Unblocks | T12 |
| Milestone | M4 |
| Status | Not started |
| Owner | TBD |

## Goal

The brief's deliverable, always in step with the board, as in the v4 mockup: a ranked list at the top left, ranked for whatever the researcher is "Looking for", with metadata, a source, a one-line reason and a figure thumbnail per paper; and a filter panel at the bottom right (fit, type, quality, year, discarded) that narrows the list and fades the filtered-out papers on the board. All of it is per viewer.

## Context

- **Visual spec:** [v4 mockup](../../mockups/README.md): "Looking for" in the top bar switches between New findings and Methods to reuse, recolouring the board and re-ranking; "Ranked list" at the top left follows the ranking and the filters, and clicking a row flies to the card; "Filter" at the bottom right has fit, type, quality (peer reviewed, cited at least 10× or 50×), year, and discarded papers. Screenshots: `shots-v4/7-rank-top.png`, `shots-v4/8-filter-quality.png`.
- The brief asks for "a ranked list of new papers with metadata, source links and relevance explanations" ([Concept: Overview](../../Concept.md#overview)); [Concept: Feature triage](../../Concept.md#product-scope) has "Rank for" and "Filters".
- Decision D11 in the group README: the list is derived from the synced paper cards.

## Scope

**In:** the "Looking for" switch (the control itself lives in T13's top bar; this WP owns its state and effects); the ranked list panel; the filter panel; fading filtered-out papers on the board; "Show discarded papers".

**Out:** scoring per goal (the discovery service scores every candidate once per board goal; the agent writes `scores` through `set_scores`, T02); the board's goal list (T08 stores it).

## Design

**Files** (`client/client/ranked/`): `rankedRows.ts` (pure: cards, goal and filters to rows), `RankedList.tsx`, `FilterPanel.tsx`, `filters.ts` (pure predicates), `goal.ts`.

**"Looking for".** The board's goals come from `GET /boards/:id` (T08), with labels ("New findings", "Methods to reuse"). The current goal is T01's per-viewer `currentGoal` atom, remembered per board in `localStorage`. Switching it recolours suggestion nodes (`scores[goal].fit`), re-ranks the list, and changes the "why" line shown in rows and the card.

**Data.** `useValue('ranked rows', () => toRows(editor.getCurrentPageShapes(), currentGoal.get(), filters.get()), [editor])`, so the list updates the moment a card is added, scored, voted on or edited, by anyone, and when this viewer changes goal or filters.

**Ranked list** (top left, "Ranked list 4" button opens it):

| Part | From |
| --- | --- |
| Header | "Ranked for new findings", "2 of 4 suggestions · filtered · clear" |
| Rank | Position by `scores[goal].score`, highest first; unscored last |
| Status line | Fit dot and label, then "Split vote" (contested), "New", "Review" (type) |
| Title, byline | Title in sentence case; "Liu et al. · Immunity · 2022 · cited 122×" |
| Why | `scores[goal].why`, two lines at most |
| Thumbnail | `figure.imageUrl`, or a "no figure" placeholder |

Only suggestions are listed (seeds and kept papers are the collection). Clicking a row runs T06's local focus and opens the card (T10). Up and Down move between rows and Enter opens; the panel keeps its own keyboard focus so tldraw shortcuts don't fire.

**Filters** (bottom right, "Filter" button with a count of active filters):

| Section | Options | Predicate on the card |
| --- | --- | --- |
| Fit | High, Medium, Low (multi-select) | `scores[goal].fit` |
| Type | Research, Review (multi-select) | `type`: Research is `article`, `preprint` and `other`; Review is `review` (T01's normalised values) |
| Quality | "Peer reviewed only (hides preprints)"; "Cited at least" Any, 10×, 50× | `peerReviewed`, `citedBy` |
| Published | Any time, Since 2023, Since 2025 | `year` |
| Discarded | "Show discarded papers" | `status === "discarded"` (T01's visibility rule) |

The panel footer shows "Showing 2 of 4 suggestions" and Clear. Under "Cited at least" it repeats v4's note that new papers haven't had time to be cited (with the best match's count), since citation counts favour old papers.

**Fading on the board.** Suggestions that don't pass the filters fade to 25 % opacity in this browser only (the same mechanism as T10's fade, read from the `filters` atom); seeds and kept papers never fade. Nothing is written to the room, so each viewer filters independently.

## Tasks

- [ ] `client/client/ranked/filters.ts`, `rankedRows.ts` with tests.
- [ ] `goal.ts`: goals from T08, the `currentGoal` atom, persistence.
- [ ] `RankedList.tsx`, `FilterPanel.tsx`; docking in `Room.tsx` (list top left, filter bottom right, per v4).
- [ ] Fading filtered-out suggestions (shared with T10's `fade.ts`).

## Acceptance criteria

1. As the agent adds and scores papers, rows appear and re-order live, in every browser.
2. Switching "Looking for" from New findings to Methods to reuse re-ranks the list and recolours nodes in this browser only (in the v4 data, Liu 2022 goes from low to high fit).
3. Each row shows status, title, byline with citation count, a why line and a thumbnail or "no figure".
4. "Cited at least 50×" hides the papers below 50 citations from the list and fades them on this viewer's board; "Showing N of M" is right; Clear restores everything.
5. Clicking a row flies to the paper and opens its card; nobody else's view moves.
6. "Show discarded papers" shows discarded papers, greyed, in this browser only.

## Tests

- `client/client/ranked/filters.test.ts`: each predicate, combinations, preprints under "peer reviewed only", missing `citedBy`, and `type: "other"` (an OpenAlex book chapter) counting as Research.
- `client/client/ranked/rankedRows.test.ts`: ranking per goal with ties and unscored papers, seeds excluded, counts.

## References

- [v4 mockup and its README](../../mockups/README.md)
- [tldraw `useValue` and signals](https://tldraw.dev/docs/editor)
