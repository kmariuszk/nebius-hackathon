# Demo script (short version)

Setup and fallbacks are in [`demo.md`](demo.md). Open the Start page at http://localhost:5173/landing/index.html?mock=1 and copy this text before you start:

```
Which single-cell methods help study melanoma immune cells?
10.1126/science.aad0501
10.1016/j.cell.2018.10.038
10.1038/s41586-021-03704-y
10.1038/s41586-022-04682-5
10.1158/1078-0432.CCR-21-1694
```

## The demo

1. **Show the Start page.** Say: "Researchers have some papers that they trust. A keyword search does not find the other papers."

2. **Paste the text into the box.** The question stays in the box, and the 5 DOIs become 5 paper chips. Click **↑**.

3. **The demo board opens.** Say: "The agent needs some minutes to find and read papers. This board started with the same question one hour ago."

4. **Click Catch me up.** The first paper opens: Ibáñez-Molero 2026.
   - Read the "Why it matters to you" box.
   - Put the mouse on an underlined phrase. The exact sentence from the abstract shows.
   - Put the mouse on "three of your seeds". The three seed papers show on the board.

   This is the most important step. The judges look for two things: why the paper is relevant, and where that information comes from.

5. **Accept one paper and delete one paper.**
   - Click **Keep**. The next paper opens: Daugherty-Lopès 2024.
   - Click **Next ›**. The next paper opens: Lopez de Rodas 2025.
   - Click **Discard**. The tour goes back to Daugherty-Lopès.
   - Click **Done**. The tour stops and the full board shows.

6. **Change the goal.** In the top bar, change **Looking for** to **Methods to reuse**. Liu 2022 moves to number 1. Say: "The ranking changes with your goal."

7. **Edit the board.**
   - Drag Daugherty-Lopès into the **Tumour ecosystem** cluster.
   - Drag a **Note** from the toolbar onto Ibáñez-Molero, and type a note.
   - Click **Update suggestions**, then click **See what it did**. The chat shows each step of the agent, with the model, the time and the cost.

8. **Stop on the board.** Say: "The list is ranked and traceable, and the researcher stays in control."
