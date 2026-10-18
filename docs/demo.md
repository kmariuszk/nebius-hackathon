# Live demo script

About three minutes. You go from the Start page to a board the agent has filled, check one paper's evidence, keep one paper, discard another, and then show how the team edits the board.

## Before you go on stage

1. Run the app: `cd client && pnpm install && pnpm dev`. Make sure you're online, because the figures and the PubMed links load from the internet.
2. Open two tabs:
   - **Tab 1:** http://localhost:5173/landing/index.html?mock=1 (Start)
   - **Tab 2:** http://localhost:5173/landing/demo-board.html (the demo board, as a backup)
3. Set the browser zoom to 100% and use a full-width window (1440px or wider is best).
4. Copy the text under "What to paste" below, so it's ready on your clipboard.

`?mock=1` means sample data: the board service doesn't create boards yet, so pressing Start opens the demo board.

## What to paste

Paste all of it into the Start box in one go. The question stays in the box and the five DOIs turn into paper chips.

```
Which single-cell methods help study melanoma immune cells?
10.1126/science.aad0501
10.1016/j.cell.2018.10.038
10.1038/s41586-021-03704-y
10.1038/s41586-022-04682-5
10.1158/1078-0432.CCR-21-1694
```

These are the five seed papers from the track brief, the same ones on the demo board:

| Seed | DOI | Free full text (PDF on the page) |
| --- | --- | --- |
| Tirosh 2016 · Science | 10.1126/science.aad0501 | https://pmc.ncbi.nlm.nih.gov/articles/PMC4944528/ |
| Sade-Feldman 2018 · Cell | 10.1016/j.cell.2018.10.038 | https://pmc.ncbi.nlm.nih.gov/articles/PMC6641984/ |
| Oliveira 2021 · Nature | 10.1038/s41586-021-03704-y | https://pmc.ncbi.nlm.nih.gov/articles/PMC9187974/ |
| Oliveira 2022 · Nature | 10.1038/s41586-022-04682-5 | https://pmc.ncbi.nlm.nih.gov/articles/PMC9815755/ |
| Smalley 2021 · Clin Cancer Res | 10.1158/1078-0432.CCR-21-1694 | https://pmc.ncbi.nlm.nih.gov/articles/PMC8282775/ |

The PDFs aren't in this repo: they're author manuscripts, free to read but not ours to redistribute. To show a PDF upload instead of a DOI, download one from its PubMed Central page beforehand and use **+ Add papers**.

If pasting goes wrong, click the **Melanoma immune cells** example under the box: it fills in the same question and seeds.

## The script

| # | Do | Say (roughly) | Time |
| --- | --- | --- | --- |
| 1 | Start page on screen. | "Researchers have a handful of papers they trust. Keyword search misses the rest." | 10 s |
| 2 | Paste, then press **↑**. | "One box: my question and the five papers I already trust." | 15 s |
| 3 | The demo board opens. | "Finding and reading candidates takes a few minutes, so here's the same question we started an hour ago." | 15 s |
| 4 | Click **Catch me up**. On the first paper (Ibáñez-Molero 2026), see the steps below the table. | "The agent walks me through what's new, and every claim points at its source." | 60 s |
| 5 | **Keep** Ibáñez-Molero. Press **Next ›** on Daugherty-Lopès (a preprint). **Discard** Lopez de Rodas (a review). | "Keep pins it to our collection, and the agent searches around it next. Discard tells it what we don't want." | 30 s |
| 6 | Switch **Looking for** (top bar) to **Methods to reuse**. | "Ranking depends on what you're looking for. Liu 2022 is weak evidence but the best method, so it jumps to number 1." | 15 s |
| 7 | Drag Daugherty-Lopès into the **Tumour ecosystem** cluster. Drag a **Note** from the toolbar onto Ibáñez-Molero and type a note. Press **Update suggestions**, then **See what it did**. | "The team owns the board. We move things, regroup and add notes, and the agent catches up when we tell it to. Every step shows the Nemotron model, time and cost." | 35 s |
| 8 | Close on the board. | "Ranked, traceable, and the researcher stays in control." | 10 s |

**Step 4 in detail:** this is the moment judges care about most, because the brief asks why each paper is relevant and where that comes from.
- Read the **Why it matters to you** box on the right.
- Hover an underlined phrase, such as "tumour-reactive". The exact sentence from the abstract appears, marked ✓ word for word. Clicking it opens PubMed with that sentence highlighted.
- Hover **three of your seeds**. The widgets fade and the three seed papers light up on the board, with their citation strings.
- Point at **The paper at a glance** on the left: samples, method, readout and finding, each marked ✓ Same or ＋ New compared with your seeds.

## If something goes wrong

- **The Start page doesn't open the board:** use **open a demo board that's been running for an hour →** under the box, or switch to tab 2.
- **No figures or PubMed links:** you're offline. The rest still works; skip the PubMed click.
- **You clicked something by mistake:** most actions show an **Undo** in the message at the bottom. Reloading the page resets the demo board.

## If a judge asks what's real

- **Real:** the papers, the quotes (checked word for word against the abstracts), the figures (PubMed Central), the citation links (PubMed) and the citation counts (Semantic Scholar).
- **Stand-ins for the agent's output:** the "why" text, the scores, the "at a glance" steps, the votes and the chat replies.
- **The real board:** the tldraw board with the agent runs separately. After `node server/seedDemo.ts demo` (from `client/`, with the server running), open http://localhost:5173/demo and use **Chat**. The chat runs on Nemotron 3.5 Super VL and needs `TF_API_KEY` in `.env`. Live search on Nemotron Lightning sometimes fails (see PR #13), so don't rely on it on stage.
