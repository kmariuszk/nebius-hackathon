# Mockups

## Current: v6, the pinboard look

v5 with the approved pinboard design. Download [`flashcard-v6.html`](flashcard-v6.html) and open it in a browser (online, for the figures and the handwriting font). It works exactly like v5 below; only the look changed.

- **Every paper is a card** that says what it is: "In your collection", or "Suggested · High fit" in words. Saved papers are pinned. New suggestions are taped up, with the agent's reading order in a red circle (it follows Looking for and the filters, and matches the ranked list).
- **Status on the corner:** New, Split vote, Reading…, ✓ Kept, Discarded, Added by you, Not linked yet.
- **Strings run pin to pin:** red for cites, a dotted thread for similar, blue for links people draw. They're faint at rest and light up for the card you point at.
- **Clusters** are faint dotted areas, named on torn tape. Everything you could do with them in v5 still works.
- **Notes** are handwritten. The agent's notes are red handwriting under new cards.
- **The opened paper's hub** is the paper's own card, circled in red marker. "Why it matters to you" shows the rank and the fit in words instead of a colour bar.
- **Pinboard** in the top bar switches the background from paper to cork. It always opens on paper.

![v6 overview](shots-v6/1-overview.png)

| | |
|---|---|
| ![An opened paper](shots-v6/2-open.png) | ![Hovering a suggestion](shots-v6/5-hover-suggestion.png) |
| ![Looking for methods to reuse](shots-v6/6-goal-method.png) | ![Pinboard switched on](shots-v6/7-pinboard-on.png) |
| ![The key](shots-v6/8-help-key.png) | ![Catch me up](shots-v6/15-catchup.png) |
| ![List and chat open](shots-v6/16-list-chat.png) | ![Editing clusters](shots-v6/14-clusters-edited.png) |

## Earlier: v5, the paper splits into widgets

The same board as v4, but opening a paper no longer shows one card. The paper splits into widgets around its node. Download [`flashcard-v5.html`](flashcard-v5.html) and open it in a browser (online, for the figures). Everything else (the list, chat, filters, notes, links, Catch me up) works as in v4 below.

We found the v4 card still overwhelming: you didn't know where to look. In v5, each widget answers one question and always sits in the same place:

```
                       [ Title ]
 [ The paper at a glance ]  ●  [ Why it matters to you ]
 [ Figure from the paper ] [Keep · Discard] [ Team notes ]
```

- **Title, on top:** title, plus first author, journal and year. A Preprint or Review flag only appears when it applies.
- **Why it matters to you, on the right:** the summary written for your question, next to the node and in the paper's fit colour. Underlined words still show their quote on hover.
- **The paper at a glance, on the left:** a small diagram of 3–4 steps (samples, method, readout, finding), each marked "✓ Same" or "＋ New" compared with your seeds. Hover a step to see the abstract sentence it comes from. It replaces v4's "Compared with your seeds" strip and three-line summary.
- **Figure from the paper:** under the diagram. The **?** panel has a switch to hide it from the first view.
- **Actions, under the node:** Keep and Discard. During Catch me up, the agent's line and Next/Prev sit here too.
- **More, or clicking the node again:** adds "What supports this" (all quotes, what wasn't checked, how it was found) and the team's notes.

![v5: an opened paper](shots-v5/1-open.png)

**What to try:**

- Hover "three of your seeds": the widgets fade and those seeds and their citation links light up on the board.
- Catch me up: each paper's widgets grow out of its node.
- Drop a Note on any widget to pin it to that paper.
- Open Daugherty-Lopès 2024: its diagram fills in once the agent finishes reading.
- Open both the list and the chat: the widgets switch to two columns.

**Less metadata in the first view.** The citation count and "added by the agent for Ana at 09:12" moved under More. PMID and DOI are gone (the title links to the paper). The model and time labels stay in the chat. ALL-CAPS titles are shown in sentence case.

**What it needs from the backend:** one more field per paper for the diagram, `glance[]`: 3–4 steps, each with a label (Samples, Method…), a short text, the ID of the quote it comes from, and `same`, `adds` or `other` against the seeds. The agent extracts it from the abstract; the app draws it, so no image model is involved.

**If there's little time to build it:** the cheapest win is separating the title from the why text. The diagram comes next.

### Editing the board

People can change everything the agent made. Each edit counts as a change, and the agent waits until someone presses **Update suggestions**, as agreed in the brainstorm. Click "N changes" in the toolbar to see what the agent will catch up on.

- **Notes:** click a note to edit it, on the board or in the open paper's notes widget. × deletes it, with Undo. Editing someone else's note shows "edited by you".
- **Clusters:** the agent groups papers by how similar their abstracts are (embeddings), and marks its clusters **AI**. A cluster's box fits around its papers. You can:
  - click its name to rename or ungroup it (renaming removes the AI tag);
  - drag the cluster to move it with its papers;
  - drag its edges or corners to make it bigger. Papers without a cluster that end up inside join it, and it can't be made smaller than its own papers;
  - drag a paper in or out. The target cluster lights up while you drag. A paper dragged out offers "Start a new cluster".
- **Papers you found:** drop a PDF on the board (or on a cluster, to put it there), paste a DOI, or use **Paper** in the toolbar. It's read, then waits as "Not linked yet". On Update suggestions the agent links it to its seeds and says which cluster fits it best, but leaves it where you put it. In the mockup every added paper becomes Sievers 2023 (Cancer Cell), a real paper that cites four of the seeds.
- **Update suggestions:** the chat shows your changes, then each step the agent took, with model and time.

**What it needs from the backend:**
- clusters stored with the board: `id`, `label`, `by` (agent or a person), the member papers, and the size a person gave them;
- user-added papers: the file or DOI, and whether the agent has read and linked them yet;
- a list of pending changes that Update suggestions sends to the agent in one go.

| | |
|---|---|
| ![Clusters with AI tags](shots-v5/12-clusters.png) | ![Renaming a cluster](shots-v5/13-cluster-rename.png) |
| ![Dragging a paper into a cluster](shots-v5/14-drag-into.png) | ![A paper dragged out](shots-v5/15-dropped-out.png) |
| ![Making a cluster bigger](shots-v5/22-cluster-resized.png) | ![Dropping a PDF](shots-v5/19-dropzone.png) |
| ![A paper you added, not linked yet](shots-v5/16-paper-added.png) | ![Editing a note in the open paper](shots-v5/18-note-edit.png) |
| ![What the agent will catch up on](shots-v5/23-changes-list.png) | ![After Update suggestions](shots-v5/24-update-log.png) |

| | |
|---|---|
| ![More: what supports this](shots-v5/2-more.png) | ![Hovering "three of your seeds"](shots-v5/3-peek.png) |
| ![Catch me up](shots-v5/5-catchup.png) | ![Still reading](shots-v5/6-reading.png) |
| ![A review without a figure](shots-v5/7-review.png) | ![A seed](shots-v5/8-seed.png) |
| ![List and chat open: two columns](shots-v5/9-narrow.png) | ![A note dropped on the paper](shots-v5/11-note-drop.png) |

## Earlier: v4, the discovery board

A clickable mockup of the whole board: the canvas, the new-paper card, the ranked list, chat, filters and notes. Download [`flashcard-v4.html`](flashcard-v4.html) and open it in a browser. It's one self-contained file with no build step. The figures load from PubMed Central, so you need to be online.

**What's real.** The papers are real: the 5 seeds from the brief, 4 suggestions that cite at least 3 of them, and 1 kept paper.

| Data | Source |
| --- | --- |
| Quotes | Word for word from the abstracts, each one checked against its abstract |
| Figures and captions | PubMed Central |
| Citation links | PubMed |
| Citation counts | Semantic Scholar, fetched 2026-10-18 |

**What's a stand-in.** The "why" lines, the comparisons, fit scores, votes, notes, chat replies and timings are hand-written stand-ins for what the agent will produce.

![Catch me up, with the tour inside the card](shots-v4/11-tour.png)

### What to try

- **Catch me up:** the agent walks through the new papers. The controls and the agent's line sit inside the card. Keep or Discard moves on to the next paper.
- **Open a paper:** click it.
  - The first view is just a figure, title, one sentence, a "Compared with your seeds" strip, and Keep or Discard.
  - Hover an underlined phrase to see the exact quote. Hover "three of your seeds" to light them up on the board.
  - Details opens Evidence, Summary and Notes.
- **Looking for:** in the top bar, switch between New findings and Methods to reuse. Liu 2022 goes from low fit to high fit.
- **Ranked list:** at the top left. Rows follow the ranking and the filters, and clicking a row flies to the card.
- **Filter:** at the bottom right: fit, type, quality (peer reviewed, cited at least 10× or 50×), year, and discarded papers.
- **Chat:** at the top right. Each step shows its model, time and cost. Paper names are clickable, and asking a question highlights papers on the board.
- **Editing:**
  - Drag papers to move them.
  - Hover a paper and drag its **+** onto another paper to link them.
  - Click a link to name it, hide it or delete it.
  - Drag a **Note** from the toolbar onto a paper to pin it there. It moves with the paper.
  - After edits, "N changes · the agent is waiting" offers **Update suggestions**, as agreed in the brainstorm: you edit, then the agent catches up.

### Design decisions

- **Three layers of detail:** the node on the board, the card's first view, then Details. The first view never needs scrolling.
- **The board is the picture:** opening a card zooms to the paper and fades everything it isn't linked to.
- **Two voices:** text from the paper is set in serif, marked ✓ or ⚠, and links to PubMed. AI text carries an "AI" tag.
- **Real figures only:** never generated images. A paper without a free full-text version gets no figure.
- **Three kinds of link:**
  - *cites* is a PubMed fact. You can add your own label to it or hide it; the citation stays in the data.
  - *similar* is the agent's guess, so you can rename or delete it.
  - *Your own links* have whatever label you give them.

  Labels you write are always visible; "cites" and "similar" only show on hover or focus.
- **Moving papers:** the agent never moves a paper a person has moved, as Concept.md says.

### What the UI needs from the backend

Beyond the Paper record in Concept.md:

- **`relevance.claims[]` with evidence IDs.** Each sentence links to a quote or a citation. A sentence with no evidence is dropped or flagged ⚠.
- **`relevance.quotes[]`:** several quotes, each with `verified`.
- **`relevance.gaps[]`:** what couldn't be checked.
- **`facets`:** the "Compared with your seeds" strip. Per paper: disease, cells and method, each as a value, `same`, `adds`, `other` or `unclear`, and the ID of the quote that supports it.
- **`type`:** article, review or preprint.
- **`citedBy`:** the citation count, for the card and the quality filter.
- **`figures[]`:** with caption, image URL and the figure picked for each goal.
- **Per-section progress:** so each part of the card fills in on its own.
- **Model and time per step:** for the labels.
- **User edits stored with the board:** moved positions (`pinnedByHuman`), links with `label` and `by`, hidden citation links, and notes with the `paper` they're pinned to.

### Things we found while building it

- **OpenAlex** refused requests without an API key once the free daily budget was used up. That budget is shared by everyone on the same internet address, so at the venue it runs out fast. Get a key, or fall back on PubMed's citation links (E-utilities `elink`, `pubmed_pubmed_citedin`), which worked fine.
- **Figures:** E-utilities `efetch db=pmc` returns figure captions and file names. The image files are linked from the article page at `pmc.ncbi.nlm.nih.gov` and served from `cdn.ncbi.nlm.nih.gov`. That page sometimes returns a small block page instead, so retry slowly. Europe PMC wouldn't serve full text for author manuscripts.
- **Citation counts favour old papers.** Our best new match has 24 citations and the preprint has 0, so a "50×" filter hides both.
- **Retracted papers:** hide or flag them always. PubMed marks them, so this is better as a rule than a filter.
- **ALL-CAPS titles:** some bioRxiv records in PubMed are all capitals. Show them in sentence case.
- **Seeds among the candidates:** one seed (Oliveira 2022) came back as a candidate because it cites the others. Remove seeds before ranking.

### Screenshots

| | |
|---|---|
| ![Overview](shots-v4/1-overview.png) | ![Open card](shots-v4/10-click-opens-card.png) |
| ![Looking for, in the top bar](shots-v4/7-rank-top.png) | ![Filter with the quality section](shots-v4/8-filter-quality.png) |
| ![Moving a paper; its pinned note follows](shots-v4/2-move-paper-note-follows.png) | ![Note pinned to a paper](shots-v4/9-note-pinned.png) |
| ![Drawing a link from the + handle](shots-v4/4-new-link-editor.png) | ![A named link](shots-v4/5-named-link.png) |
| ![Editing a citation link](shots-v4/6-edit-cites-link.png) | ![Hover handle](shots-v4/3-hover-handle.png) |

## Earlier: v1, the first panel

[`paper-panel.html`](paper-panel.html) is the first mockup: a fixed side panel with every field visible at once, and made-up papers. The team found it too text-heavy, which led to v4's layered card. It's kept for reference.

| | |
|---|---|
| ![v1 canvas with panel](shots/canvas.png) | ![v1 full card](shots/card-full.png) |
