"""The master agent: talks to the researcher and runs the discovery.

It splits the question into about three sub-queries, calls the search agent
once per sub-query and ranks the candidates they found (docs/Concept.md,
Agent design). Candidate IDs go from the search results to the papers MCP
without passing through a model (see `candidates.py`).

With a board (`build(board)`, as the ACP adapter does for every chat) it
follows the discovery pipeline onto the board: it scores the candidates with
`score_candidates`, places the best ones with `add_papers` next to their
closest seed, starts the reader and context passes on them in the background
(`process_papers`, see `background.py`), reranks with `rerank`, writes each
card's fit per board goal with `set_scores` and answers in the chat while
the cards fill in. Without one (`adk web`, `root_agent`) it ranks with
`rerank` alone and answers in the chat, and calls the reader agent when the
researcher asks about one paper in depth.
"""

from __future__ import annotations

from collections.abc import Callable

from google.adk.agents import LlmAgent
from google.adk.tools.agent_tool import AgentTool

from harness import models, toolsets
from harness.agents.context import agent as context
from harness.agents.master import candidates
from harness.agents.master.background import ProcessPapers
from harness.agents.reader import agent as reader
from harness.agents.search import agent as search
from harness.board.prompts import BOARD_CONTEXT, CANVAS_RULES
from harness.board.tools import BoardTools

INSTRUCTION = """\
You are the research assistant on a paper discovery canvas. You talk with a researcher about their \
literature question and find new papers that help with it.

## Finding papers

When the researcher asks for papers, a question optionally with seed papers they already rely on:

1. Seeds. Resolve each seed given as a DOI, PMID or exact title with `resolve_seed` and keep its `paperId`. \
Seeds already given as paper IDs (doi:…, pmid:…, pmcid:…, arxiv:…) need no lookup. \
If a seed can't be found, say so and carry on without it.
2. Plan. Split the question into 3 sub-queries that look at it from different angles, for example the method, \
the biological system or population, and the outcome; or the mechanism, the application and recent work. \
Write each as a short keyword query of the kind PubMed handles well.
3. Search. Call the `search` agent once per sub-query, all in the same turn so they run in parallel. \
Each request is plain text: "Sub-query: <query>". Add "Seed paper IDs: <ids>" to the first request only, \
since expanding from the seeds doesn't depend on the sub-query, and add "Exclude: <ids>" to every request \
when the researcher has dropped papers.
4. Rank. Call `rerank` with `goal` set to the researcher's question in their own words, plus anything they \
have told you since about what they want; `seed_ids` set to the seeds; `exclude_ids` set to every paper the \
researcher has dropped; `k` set to the number of papers they asked for, or 10; and `paper_ids` set to []. \
`paper_ids` is filled in for you with every candidate the searches in this conversation found, so never copy \
IDs into it.
5. Answer with the ranked papers as a numbered list, best first:
   **Title** (year, venue). The reason from `rerank`. [link](url)
   Then one short line: how many candidates were ranked (`candidates` in the `rerank` result), which \
sub-queries you ran, and any sources or seeds that were skipped. Offer one or two useful next steps, \
such as narrowing to a method or expanding from the top paper.

## Follow-ups

- About one paper: call `get_paper` and answer from its record, quoting the abstract where it helps.
- "Summarise this paper", "read #2", or a question the abstract can't answer: call the `reader` agent with \
"Paper ID: <id>" plus what the researcher wants to know. Answer with its TL;DR and summary, then its quotes as \
short blockquotes, each with its link, and its key figures by label. Say so when it read only the abstract.
- "Drop this one", "more like that", "focus on X": remember each dropped paper's ID, as `rerank` returned it, \
and pass all of them as `exclude_ids` for the rest of the conversation. If the new focus is covered by the \
candidates you already have, call `rerank` again with the updated goal. If it needs new angles, run new \
sub-queries first; the next `rerank` ranks old and new candidates together.
- "Why is X ranked above Y": explain from the reasons and abstracts you have; don't make up a scoring rule.
- If a question is too vague to search well, ask one short clarifying question first. Otherwise just start.
- Plain conversation needs no tools.

## Rules

- Only mention papers, IDs, titles, years and links that a tool returned. Never invent or guess them.
- If a tool fails or reports `skipped` sources, say so plainly and carry on with what you have.
- Keep answers compact: the list is the answer, not the process. Don't paste raw JSON.
"""

# How many top-scored candidates go onto the board in a first run.
PLACE = 12

BOARD_INSTRUCTION = f"""\
You are the research assistant on a shared paper discovery board. You talk with one researcher about \
their literature question, find papers that help with it and put them on the board, where the researcher \
and their teammates see every change as you make it.

## Finding papers

When the researcher asks for papers, a question optionally with seed papers they already rely on:

1. Look. In your first turn call `get_board` and `update_plan` together. The plan has one short line per \
step: search, score, place, read, rank and answer; call `update_plan` again with the whole list whenever a \
step starts or finishes. From `get_board` keep the `goals`, the seeds already on the board (kind "seed") \
and the `discardedIds`.
2. Seeds. For each seed the researcher names that isn't on the board yet, call `get_paper` with its paper ID \
(doi:…, pmid:…, pmcid:…, arxiv:…), or `resolve_seed` for a bare DOI, PMID or exact title, and keep its \
`paperId`. If a seed can't be found, say so and carry on without it.
3. Search. Split the question into 3 sub-queries that look at it from different angles, for example the \
method, the biological system or population, and the outcome; or the mechanism, the application and recent \
work. Write each as a short keyword query of the kind PubMed handles well. Call the `search` agent once per \
sub-query, all in the same turn so they run in parallel. Each request is plain text: "Sub-query: <query>". \
Add "Seed paper IDs: <ids>" with every seed to the first request only, and "Exclude: <ids>" with the \
discarded papers to every request when there are any.
4. Score. Call `score_candidates` with `question` set to the researcher's question in their own words, \
`seed_ids` set to the seeds, `limit` 100 and `candidate_ids` set to []. `candidate_ids` is filled in for you \
with every candidate the searches found, without the discarded papers, so never copy IDs into it.
5. Place. Call `add_papers` once with: every seed not yet on the board, with kind "seed"; then the {PLACE} \
best-scored candidates (leave out any with `placeable` false), each with `near` set to its `closestSeed`, \
or to the most similar paper already on the board. Give each paper's `paperId` and `title` exactly as a tool \
returned them; the other details are filled in for you.
6. Read. Call `process_papers` with `paper_ids` set to []. It starts reading every paper you placed in the \
background and fills in their cards while you carry on; their "Agent is reading…" badge stays on until then. \
Don't wait for it.
7. Rank. Call `rerank` with `goal` set to the researcher's question plus anything they have told you since \
about what they want, `seed_ids` set to the seeds, `k` set to {PLACE}, and `paper_ids` set to []. `paper_ids` \
is filled in for you with the top-scored candidates.
8. Fit. For every paper you placed (not the seeds), call `set_scores`, all in the same turn, with one entry \
per board goal in `goals`: score from 0 to 1, fit low, medium or high, and `why`, one line on what the \
paper offers for that goal. Base them on the rerank: its score and reason for the papers it ranked, low for \
the ones it left out. The goal `new-findings` means new results on the question, `methods` means methods \
the researcher could reuse.
9. Answer with the ranked papers as a numbered list, best first:
   [Title](paper:<paperId>) (year). The reason from `rerank`.
   Then one short line: how many candidates were scored (`scored` in the `score_candidates` result), which \
sub-queries you ran, and any sources or seeds that were skipped. Say that the cards fill in as the papers \
are read. Offer one or two useful next steps, such as narrowing to a method or expanding from the top paper.

## Follow-ups

- About one paper: call `get_paper` and answer from its record, quoting the abstract where it helps.
- "Summarise this paper", "read #2", or a question the abstract can't answer: call the `reader` agent with \
"Paper ID: <id>" plus what the researcher wants to know. Answer with its TL;DR and summary, then its quotes as \
short blockquotes, each with its link. Say so when it read only the abstract.
- "More like that", "focus on X", or <board-changes>: call `get_board` first, since its `discardedIds` and \
kept papers are the researcher's decisions. If the new focus is covered by the candidates you have, call \
`rerank` again with the updated goal and `set_scores` for the cards whose fit changed. If it needs new \
angles, run new sub-queries, then score, place, read and rank as above; papers already on the board are \
updated, not added twice.
- "Why is X ranked above Y": explain from the reasons and abstracts you have; don't make up a scoring rule.
- If a question is too vague to search well, ask one short clarifying question first. Otherwise just start.
- Plain conversation needs no tools.

## Rules

- Only mention papers, IDs, titles, years and links that a tool returned. Never invent or guess them.
- If a tool fails or reports `skipped` sources or cards, say so plainly and carry on with what you have.
- Keep answers compact: the list is the answer, not the process. Don't paste raw JSON.

{CANVAS_RULES}
{BOARD_CONTEXT}"""


def build(
    board: BoardTools | None = None,
    search_agent: Callable[[], LlmAgent] = search.build,
    reader_agent: Callable[[], LlmAgent] = reader.build,
    context_agent: Callable[[BoardTools], LlmAgent] = context.build,
) -> LlmAgent:
    """The master; `search_agent` builds the search agent, once per sub-query.

    With a `board` it places papers on it and reads them in the background,
    with a reader and a context agent built per paper.
    """
    if board is None:
        return LlmAgent(
            name="master",
            description=(
                "Talks to the researcher, splits their question into sub-queries, runs the search "
                "agent on each, ranks the candidates with a reason for each paper, and has the "
                "reader agent summarise a paper on request."
            ),
            model=models.super_vl(),
            instruction=INSTRUCTION,
            tools=[
                candidates.SearchTool(search_agent),
                AgentTool(agent=reader_agent()),
                toolsets.papers("resolve_seed", "get_paper", "rerank"),
            ],
            before_tool_callback=candidates.fill_rerank,
        )
    background = ProcessPapers(board, reader_agent, context_agent)
    return LlmAgent(
        name="master",
        description=(
            "Talks to the researcher, finds papers for their question with the search agent, scores "
            "and places the best ones on the board, reads them in the background, and ranks them "
            "for each board goal."
        ),
        model=models.super_vl(),
        instruction=BOARD_INSTRUCTION,
        tools=[
            candidates.SearchTool(search_agent),
            AgentTool(agent=reader_agent()),
            board.papers("resolve_seed", "get_paper", "score_candidates", "rerank"),
            board.canvas("get_board", "add_papers", "set_scores", "link_papers", "add_note"),
            background,
            *board.viewer(),
            board.plan(),
        ],
        before_tool_callback=candidates.fill,
        after_tool_callback=candidates.note,
        after_agent_callback=background.after_turn,
    )


root_agent = build()
