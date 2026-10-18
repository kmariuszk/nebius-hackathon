# Mockups

## Current: v4, the discovery board

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
