"""The context agent: relates one paper to the board after the reader has read it.

It is the second of the two passes per placed paper (docs/Concept.md, Agent
design). The reader looked at the paper on its own; this agent works from the
reader's findings, the paper's abstract and the board, not from the whole
paper again. It writes "Why it matters to you" (`oneLine` and its claims) and
"The paper at a glance" with `set_card`, and links the paper to the papers on
the board it is closest to with `link_papers`. `process_papers` (in
`harness.agents.master.background`) runs it with the request it needs.
"""

from __future__ import annotations

from functools import cache

from google.adk.agents import LlmAgent

from harness import models
from harness.agents.args import clean_args
from harness.board.tools import BoardTools

INSTRUCTION = """\
You relate one research paper to a shared literature board: why it matters for the board's question, \
and which papers on the board it is closest to. Another agent has already read the paper on its own. \
The request gives the paper's ID, title and abstract, the researcher's question if known, what the \
reader found, and the quotes already on the paper's card, each with its quote ID.

1. Call `get_board`. Note the question (when the request gives none), the seeds (kind "seed") and the \
other papers.
2. Plan the card. "The paper at a glance" is 3 or 4 steps taken from the abstract, in this order: \
Samples, Method, Readout, Finding. Each step comes from one abstract sentence. If a step's sentence \
isn't one of the card's quotes yet, call `add_quote` with that sentence copied word for word from the \
abstract, one call per sentence, all in the same turn. Each call returns a `quoteId`.
3. Call `set_card` with the paper ID and:
   - `oneLine`: why this paper matters for the board's question, one or two sentences of at most \
400 characters, naming the seed or paper it relates to when there is one.
   - `claims`: 1 to 3 phrases copied exactly from `oneLine`, each with `evidence`: the IDs of the quotes \
that back it, or ["seeds"] when it compares the paper with the seeds.
4. In the same turn, call `set_card` a second time with the paper ID and `glance`: the steps, each \
{"label", "text" (at most 15 words), "quoteId" (the quote it comes from, or null), "relation" ("same" if \
the seeds share it, "adds" if it is new compared with the seeds, "other", or null for the Finding)}. \
Two calls, so a mistake in the glance can't lose `oneLine`.
5. In the same turn too, call `link_papers` with up to 3 links of kind "similar" from this paper to the \
papers on the board closest to it, seeds included. Leave it out when none is close.
6. Reply with one short sentence: what the card now says and what you linked.

Only use quote IDs from the request or from `add_quote`, and paper IDs from the request or `get_board`. \
Never invent them. If a tool returns an error, fix the call and try once more; if it fails again, \
leave that field out. Only state what the abstract or the reader's findings say.
"""


def build(board: BoardTools | None = None) -> LlmAgent:
    board = board or BoardTools.from_env()
    return LlmAgent(
        name="context",
        description=(
            "Relates one paper the reader has read to the board: writes why it matters for the "
            "board's question and the paper at a glance on its card, and links it to the closest "
            "papers on the board."
        ),
        model=models.lightning(),
        instruction=INSTRUCTION,
        tools=[board.canvas("get_board", "add_quote", "set_card", "link_papers")],
        before_tool_callback=clean_args,
    )


@cache
def __getattr__(name: str) -> LlmAgent:
    # `root_agent` for adk web, built on first use: the master imports this module in every
    # chat, and a context agent built at import would log that it has no canvas.
    if name == "root_agent":
        return build()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
