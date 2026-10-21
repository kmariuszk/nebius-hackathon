# T10: Paper widgets (v5) and PDF reading

| Field | Value |
| --- | --- |
| Lane | Browser |
| Size | L (Phase A, the widgets: M; Phase B, PDF reading: M) |
| Depends on | T01, T08 (T06 for Catch me up and lighting up seeds; votes go through the editor until T08 exists) |
| Unblocks | T12 |
| Milestone | M4; the Oct 20 refresh is W2 One clean run |
| Priority | P1 (refresh) |
| Status | Phase A (the widgets) built and on `main` by Oct 18, in the v6 look since PR #21; Phase B (PDF reading) not started and out of the Oct 20 plan. Refresh (Oct 20) not started: see What's left |
| Owner | TBD |

## Where it stands (Oct 20)

| Part | State | Where |
| --- | --- | --- |
| Widgets around the opened node: title, Why it matters to you, The paper at a glance, figure, actions, Team notes, What supports this (More), linked papers | Built | `client/client/widgets/PaperWidgets.tsx`, `parts.tsx`, `placement.ts` |
| Fade to what's linked, peek "three of your seeds", claim and glance quotes on hover | Built | `widgets/fade.ts`, `claims.ts`, `parts.tsx` |
| Keep, Discard, Undo through the vote route | Built; Keep doesn't move on during Catch me up (F15) | `widgets/votes.ts`, `parts.tsx` (`ActionsWidget`) |
| Two columns with the list and chat open | Built | `widgets/placement.ts` |
| Pinning a note by clicking a widget with the Note tool | Built | `PaperWidgets.tsx` (`Anchored`, `onNoteTool`), `widgets/boardWrites.ts` |
| Empty states | Glance shows "Reading the paper…" and the figure "Finding the most relevant figure…" whenever they're empty, even after the reading ended or failed, and on every seed, which is never read (F20) | `parts.tsx` (`GlanceWidget`, `FigureWidget`) |
| "Find more like this" | Dispatches `pdc:ask`; nobody listens (F18) | `parts.tsx` |
| Real figures | The widget is built; no figure ever reaches a card ([D05](../discovery/D05-real-figures.md)) | `parts.tsx` (`FigureWidget`) |

## What's left (v6)

**Empty states that end** (F20), keyed on the card's `working` flag, its `gaps` and its `kind`:

| Widget | While `working` | Not working, empty | Seed (never read) |
| --- | --- | --- | --- |
| Why it matters to you | The current "Still reading…" line | The card's gap that starts "The agent couldn't write why…" ([H03](../agent-harness/H03-background-never-silent.md)), else "The agent hasn't explained this paper yet." | "One of your seed papers." and its fit line hidden |
| The paper at a glance | Spinner and skeleton, as now | The gap "The agent couldn't draw the paper at a glance.", else the widget is hidden | Hidden |
| Figure | "Finding the most relevant figure…" | "No free figure for this paper." in small type | Hidden unless the card has a figure |

**A hook for the tour:** `ActionsWidget` takes an `onVoted(decision)` callback from `PaperWidgets`, called after a vote succeeds, which the [T06 refresh](T06-viewer-actions.md)'s tour uses to move on; the tour bar renders inside the same widget.

**Find more** goes through the [T05 refresh](T05-chat-panel.md)'s `chatBus.ask`.

**Out of this plan:** Phase B (PDF reading, shared highlights, "Ask about this area"); criterion 9 below stays open.

**Tasks:**

- [ ] `client/client/widgets/parts.tsx`: the empty states; `onVoted`; Find more through `chatBus`.
- [ ] `client/client/widgets/PaperWidgets.tsx`: pass `onVoted` and the tour state.
- [ ] Tests: a pure `emptyState(card, widget)` helper in `widgets/emptyStates.ts` with `emptyStates.test.ts` (working, failed with a gap, seed, figure present).

**Acceptance criteria (refresh):**

1. Opening a seed shows "One of your seed papers." and no spinner anywhere.
2. Opening a card whose context pass failed shows the gap text in "Why it matters to you" and no endless spinner.
3. A paper without a figure shows "No free figure for this paper." once its reading has finished.
4. During a tour, Keep and Discard move to the next paper (with the T06 refresh).

## Goal

Clicking a paper zooms to it, fades everything it isn't linked to, and splits the paper into widgets around its node, as in the v5 mockup. Each widget answers one question and always sits in the same place: the title on top, "Why it matters to you" on the right, "The paper at a glance" and a real figure on the left, and the actions under the node. The first view never scrolls. More, or clicking the node again, adds what supports the paper and the team's notes. Catch me up runs in the same widgets.

## Context

- **Visual spec:** the [v5 mockup](../../mockups/README.md) (`docs/mockups/flashcard-v5.html`; screenshots in `docs/mockups/shots-v5/`: `1-open.png`, `2-more.png`, `3-peek.png`, `5-catchup.png`, `6-reading.png`, `7-review.png`, `8-seed.png`, `9-narrow.png`, `11-note-drop.png`). The layout:

  ```
                         [ Title ]
   [ The paper at a glance ]  ●  [ Why it matters to you ]
   [ Figure from the paper ] [Keep · Discard] [ Team notes ]
  ```

- **Why v5:** the team found the v4 card still overwhelming: you didn't know where to look. In v5 each widget answers one question in a fixed place (decision D22). v4 had replaced the text-heavy v1 panel (`paper-panel.html`).
- **What v5 keeps from v4** (`flashcard-v4.html`): "the board is the picture" (opening a paper zooms to it and fades what isn't linked); two voices (text from the paper in serif, marked ✓ or ⚠, linking to PubMed; AI text tagged "AI"); real figures only.
- **Contracts:** the widgets read the `paper-card` props in `client/shared/paperCard.ts` (T01) and the per-viewer atoms `openPaperId`, `paperMoreOpen` and `litPaperIds` in `client/client/viewerState.ts`. `Room.tsx` already mounts `PaperWidgets` from `client/client/widgets/PaperWidgets.tsx` (a stub until this WP).
- [Concept: Product scope, flows 3 and 5](../../Concept.md#product-scope): the new-paper card, and reading and highlighting a paper together.

## Scope

**Phase A, the widgets (v5):** opening and closing; zoom and fade; the Title, Why it matters to you, The paper at a glance, Figure, Actions and Team notes widgets; More; Keep and Discard; hover quotes; lighting up seeds; Catch me up in the actions widget (with T06); loading states; the two-column layout; notes dropped on a widget.

**Phase B, PDF reading** (in Concept, **not in the v4 or v5 mockup**; confirm with the UI owner before building): the PDF with shared highlights, and "Ask about this page / this area" for the agent (T07).

**Out:** where the widgets' content comes from (the agent fills it through `set_card` and `add_quote`, T02; the discovery service supplies figures, citation counts and how each paper was found, [I5](interfaces.md#i5-what-the-board-service-needs-from-the-papers-mcp) and [I9](interfaces.md#i9-discovery-data-the-v5-widgets-show)).

## Design

**Files** (`client/client/widgets/`): `PaperWidgets.tsx` (the entry point `Room.tsx` mounts), one component per widget, `QuoteHover.tsx`, `placement.ts`, `fade.ts`, `claims.ts`, `votes.ts`; Phase B in `client/client/reader/`.

**Rendered over the canvas, outside `<Tldraw>`.** `PaperWidgets` is a sibling of `<Tldraw>` inside `.Board-canvas`, so pointer and keyboard events in the widgets never reach tldraw. It positions each widget from the node's page bounds with `editor.pageToViewport`, inside a `useValue` on the camera and the node, so the widgets move with the board when someone pans, zooms or moves the paper.

**Opening and closing.** A paper opens when `openPaperId` is set: by clicking its node (`onClick` in `PaperCardShapeUtil`, T01), or through `openPaper(paperId)`, which a ranked list row (T09), `_canvas/open_paper` and Catch me up steps (T06) call. Clicking the open node again, or More in the actions widget, toggles `paperMoreOpen`. × Close, Escape or clicking empty canvas clears both.

**Zoom and fade ("the board is the picture").**

- Zoom: the camera puts the node where the widgets expect it and zooms so its linked papers stay on screen, a little zoomed out so the board behind stays calm.
- Fade: everything except the paper, the papers it's linked to, those links and its pinned notes drops to 25 % opacity, in this browser only. Our own shapes read `openPaperId`; built-in shapes (arrows, notes, frames) are faded by a generated style rule keyed on the `data-shape-id` attribute tldraw 5.5 puts on every shape wrapper. Nothing is written to the room.
- Notes pinned to the open paper show in its Team notes widget and are hidden on the canvas while it's open, so they don't appear twice.
- The links to the open paper show their labels (`cites`, `similar`, a person's own label) while it's open (T14's hover rule otherwise).

**Placement** (`placement.ts`). Three columns around the node, about 330, 380 and 370 px wide with 34 px gaps, as in v5:

| Column | Widgets, top to bottom |
| --- | --- |
| Left | The paper at a glance, then the figure |
| Centre | Title, the node, the actions |
| Right | Why it matters to you, Team notes, then What supports this (under More) |

The group scales down to fit the free width between the docked panels (ranked list, chat). The side columns line up their first widget with the node; whatever doesn't fit scrolls inside its column. Thin connector lines run from the node into each widget. When the list and the chat are both open, the widgets switch to two columns: the centre, and one side column with Why it matters to you, then the glance and the figure, then the rest (`9-narrow.png`).

**The first view** (never scrolls):

| Widget | Where | Content (props from `paperCard.ts`) |
| --- | --- | --- |
| Title | Top, above the node | A Preprint or Review flag, only when it applies (`type`); the title in sentence case (`sentenceCase`), linking to the paper (`url`); first author, journal and year ("Ibáñez-Molero et al. · Nature · 2026": `shortAuthors(authors)`, `venue`, `year`); "Open paper ↗" |
| Why it matters to you | Right of the node, edged in the fit colour | The fit line ("● High fit for new findings · New": `scores[currentGoal]`, `status`); `oneLine` with each of its `claims` underlined: hovering one shows its quote from `quotes` in serif, with ✓ (verified, "In the abstract, word for word") or ⚠ (not found word for word) and a PubMed link with a `#:~:text=` fragment; a claim whose evidence is `seeds` ("three of your seeds") lights up those seeds instead (below). Tagged "AI" |
| The paper at a glance | Left of the node | `glance`: 3–4 steps (samples, method, readout, finding) drawn as a small vertical diagram. Each step shows its `label` and `text`, and a mark against the seeds: ✓ Same (`same`), ＋ New (`adds`), ≠ Differs (`other`), or none (`null`, usually the finding, which is drawn last and bold). The icon follows the label (Samples, Method, Readout, Finding; other labels get a plain one). Hovering a step shows the abstract sentence it comes from (`quoteId`). Footer: "Same or new compared with your seeds. Hover a step to see the sentence it comes from." Tagged "AI". A review gets steps that fit it (Covers, Methods reviewed, Offers in `7-review.png`) |
| Figure | Under the glance | `figure`: the image, "Fig. 3 · from the paper", and the caption, with an "AI" tag when `captionByAi`; clicking the image opens it large with the paper's credit. The help (**?**) panel has a switch to hide the figure from the first view; it then shows under More |
| Actions | Under the node | × Close · More · Discard · Keep. When teammates have voted: "Split vote: Ana kept it · Igor discarded it". During Catch me up, the agent's line and Next/Prev sit here too (below) |
| Team notes | Right, under Why it matters to you | Shown when the paper has pinned notes (always under More): the notes pinned to it (T01 `note-pin`), each with its author's name and colour, and "Add a note. Everyone on the board sees it.", which creates a note pinned here |

**Less metadata in the first view.** The citation count and "added by the agent for Ana at 09:12" moved under More. PMID and DOI are gone (the title links to the paper). The model and time labels stay in the chat (T05): the widgets carry a plain "AI" tag, while T02 still records `provenance` (`{model, at}`) for each field the agent writes.

**More** (`paperMoreOpen`; the button reads "Less" while it's open):

| Section | Content |
| --- | --- |
| What supports this | Every quote in `quotes`, in serif, with "✓ Word for word · PubMed ↗" or "⚠ Not in the abstract word for word"; "On your board: cites N of your seeds" (hovering a name lights it up); "Not checked" from `gaps`; how it was found (`foundBy`), the citation count (`citedBy`, Semantic Scholar) and "added by the agent for Ana at 09:12" (from `meta.createdBy` and `meta.onBehalfOf`, the time from T08's paper record); `summary`, if the agent wrote one, next to the original abstract (`GET /papers/:paperId`, T08); "Open full paper" and "Ask the agent about it" (opens the chat with this paper as context, T05, T07) |
| Team notes | Always shown under More |
| Figure | Only if the help switch hid it from the first view |

**Seeds and kept papers** (`8-seed.png`). The title widget says "In your collection · Seed from Ana" (or "Kept by …"); the figure is on the left; the right shows "Suggestions linked to it" (each with its fit colour and "cites it"; clicking one opens it); the actions are × Close and "Find more like this", which sends a prompt on this viewer's chat (T05). No glance and no More. A discarded paper, shown with "Show discarded papers" (T09), offers "Bring it back" instead of Keep and Discard.

**Lighting up seeds.** Hovering "three of your seeds" (a claim with evidence `seeds`), or a seed name under More, fades the widgets and sets `litPaperIds` to the seeds this paper cites (its `cites` links), so those seeds and their citation links light up on the board (`3-peek.png`). A small popover says "Cites 3 of your seeds", names them, and adds "From PubMed's citation links. A citation is a link, not agreement." Moving away clears it. This browser only.

**Loading states.** A widget whose data hasn't arrived shows a quiet loading line and fills in when the agent writes it, live through sync (`6-reading.png`):

| Widget | While waiting |
| --- | --- |
| The paper at a glance | "Reading the paper…" over three grey lines, while `glance` is empty |
| Figure | "Finding the most relevant figure…", while `working` is true and `figure` is null |
| Why it matters to you | "Still reading. The rest fills in as it's ready.", while `working` is true |

A paper without a free full text shows no figure: once `working` is false and `figure` is still null, the figure widget becomes a short "No figure · There's no free full text, so the agent couldn't read the figures." (`7-review.png`). Anything else discovery can't supply yet (citation count, how it was found) is left out, not faked.

**Catch me up** (with T06). Each paper's widgets grow out of its node, one after another (`5-catchup.png`). The actions widget gets a dark header: "CATCH-UP · 1 OF 3", step dots, ‹ Prev, Next › (Done on the last step), × to end, and the agent's line for this paper; × Close is hidden while the tour runs. Keep or Discard records the vote and moves to the next paper; the last one closes the widgets, zooms back out and says "You're caught up." The arrow keys step too.

**Votes** (`votes.ts`). Keep and Discard record the vote and show a toast with Undo for a few seconds ("Kept. The agent will search around Liu 2022 on the next run."). Outside Catch me up, Discard closes the widgets.

- Until T08 exists, a vote updates the card through the editor: `keepBy`, `discardBy`, `status` (with T08's triage rules) and `kind`, which follows the status (`kept` when the status is kept, `suggestion` otherwise; seeds stay seeds), synced to everyone like any edit. T01's side effects don't set `editedByHuman` for these props, so a vote never locks the paper for the agent.
- Once T08 is in, `votes.ts` calls `PUT /boards/:id/papers/:paperId/vote` instead, and the board service writes the same props in one room transaction.

**Notes dropped on a widget.** Dropping the bottom bar's **Note** (T13, T14) on any widget of the open paper pins it to that paper (`11-note-drop.png`). The widgets sit outside the canvas, so tldraw can't hit-test them: `PaperWidgets` tells T14's drop handler which paper is under the pointer. Team notes opens with its input focused ("Type your note. It's pinned to Liu 2022."), and Enter creates the note beside the node with a `note-pin` binding (T01).

**If time is short** (Ralph's cheapest fallback): separate the title from the why text first (the Title widget on top and Why it matters to you on the right, with the actions under the node); the glance diagram next; then the figure, Team notes and More.

**Phase B: PDF reading** (if confirmed). "Read the paper" under More opens a reader over the canvas (a sibling of `<Tldraw>`):

- `pdfjs-dist@6.4.299` from `GET /papers/:paperId/pdf` (T08), pages rendered lazily with pdf.js's text layer; no free PDF: the abstract only.
- Highlights: selecting text offers "Highlight" with an optional note; it creates a `highlight` shape (T01) beside the paper with page, text and page-relative rects; everyone's highlights render in the PDF in their author's colour, with notes and replies.
- Agent highlights (`add_highlight`, T02) are placed by searching their text in the page's text content; misses are listed as not placed.
- "Ask about this page" and "Ask about this area" (drag a box over a figure or table) attach the page or the crop as an image for Super VL, with a caption (T07). The agent can also open pages itself with `look_at_paper` (T07), reusing this reader's loaded document when it's the same paper.

## Tasks

- [ ] Phase A: `client/client/widgets/`: `PaperWidgets.tsx` and the widget components; `placement.ts` (three or two columns, anchored to the node, scaled to fit); `fade.ts` (the related-shape set and the style rule); `claims.ts` (splitting `oneLine` by `claims`, quote lookup for claims and glance steps); `votes.ts` (through the editor now, `PUT /vote` once T08 lands) with Undo.
- [ ] Phase A: `onClick` in `PaperCardShapeUtil` (T01) sets `openPaperId`, or toggles `paperMoreOpen` on the open node; T06's `open_paper` and tour handlers call `openPaper(paperId)` and drive the actions widget's tour header.
- [ ] Phase A: lighting up seeds through `litPaperIds`; the loading states; the help switch for the figure; notes dropped on a widget (with T14).
- [ ] Phase B (after confirming scope): `client/package.json` adds `pdfjs-dist@6.4.299`; `client/client/reader/` (PDF view, highlights, ask about page or area).

## Acceptance criteria

1. Clicking a suggestion zooms to it, fades unrelated shapes in this browser only (a second browser is unchanged), and opens its widgets around the node: the title on top, Why it matters to you on the right in the fit colour, The paper at a glance and the figure on the left, and × Close · More · Discard · Keep under the node, with no scrolling at 800 px window height.
2. Hovering an underlined phrase shows the verbatim quote in serif with ✓ or ⚠; the link opens PubMed with the sentence highlighted. Hovering a glance step shows the abstract sentence it comes from. Hovering "three of your seeds" fades the widgets and lights up those seeds and their citation links, on this screen only.
3. When the agent writes `oneLine` and later `glance` through `set_card`, the open widgets fill in as each arrives ("Reading the paper…" until then), in every browser that has the paper open.
4. Keep moves the paper to kept for everyone (through the editor before T08, `PUT /vote` after) and offers Undo; during Catch me up it moves to the next paper, whose widgets grow out of its node with the agent's line under it.
5. More, or clicking the node again, adds What supports this (every quote, what wasn't checked, how it was found, the citation count) and Team notes. The first view shows no citation count, PMID, DOI, model or time.
6. A preprint shows the Preprint flag and an article none. A paper without a free full text shows no figure, and nothing breaks.
7. With the ranked list and the chat both open, the widgets switch to two columns and still leave the node visible.
8. Dropping a Note on any widget pins it to that paper: it shows in Team notes and moves with the node, in every browser.
9. Phase B, if built: Ana's highlight appears in Ben's PDF with her name; "Ask about this area" around a figure gets a description of the figure from Super VL.

## Tests

- `client/client/widgets/fade.test.ts`: the related-shape set (links both ways, pinned notes, hidden links excluded).
- `client/client/widgets/claims.test.ts`: splitting `oneLine` into phrases by `claims` (a claim that isn't in `oneLine` stays plain text); unknown quote IDs in claims and glance steps flagged.
- `client/client/widgets/placement.test.ts`: three or two columns from the free width; the first side widget lined up with the node; scaling to fit.
- `client/client/widgets/votes.test.ts`: the props a Keep, a Discard and an Undo write, with the status from T08's triage rules.
- Manual: the two-browser checks in criteria 1, 3, 4 and 8, recorded for T12.

## Risks

- **Fading built-in shapes per viewer** relies on tldraw's `data-shape-id` attribute; if a tldraw update renames it, the fallback is fading only our own shapes and arrows through an overridden arrow util.
- **Widgets outside the canvas lag the camera**: if positioning from `pageToViewport` stutters while panning, hide the connector lines during camera moves.
- **Props arrive in pieces**, so the widgets must look intentional while half-empty; v5's loading states are the guide.
- **v5 has more parts than v4's card**: the fallback order above keeps something shippable at each step.
- **Phase B scope:** the PDF reader isn't in v4 or v5; building it before the widgets are done risks the demo.

## References

- [v5 mockup and its README](../../mockups/README.md) (v4 in the same README for what v5 doesn't change)
- [pdf.js](https://mozilla.github.io/pdf.js/), [text fragments (MDN)](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment/Text_fragments)
- [Concept: Product scope](../../Concept.md#product-scope)
