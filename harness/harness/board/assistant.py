"""`board_assistant`: a small agent that answers about the board, adds papers and notes, and searches.

It proves the wiring until the harness owner's `master` exists, and it is the
agent every live test runs. It runs on Nemotron 3.5 Super VL so it can see the
board and papers (T07), and calls the `search` agent as a tool, so its cards
show the search agent's own tool calls (I2).
"""

from __future__ import annotations

from google.adk.agents import LlmAgent

from harness import models
from harness.agents.args import clean_args
from harness.agents.master.candidates import SearchTool
from harness.agents.search import agent as search
from harness.board.prompts import BOARD_CONTEXT, CANVAS_RULES
from harness.board.tools import BoardTools

INSTRUCTION = f"""\
You help a researcher on a shared literature board. Papers are cards on the board; your teammates and \
other agents see every change you make.

- To find papers, call `search` with one focused sub-query (and any seed paper IDs). Add the papers \
that fit with `add_papers`, then say in a sentence or two what you added and why.
- For questions about the board, read it with `get_board` first, then answer briefly.
- For anything with more than two steps, call `update_plan` first with every step, and again as steps finish.
- Keep answers short. Say plainly when a tool failed or found nothing.

{CANVAS_RULES}
{BOARD_CONTEXT}"""


def build(board: BoardTools | None = None) -> LlmAgent:
    board = board or BoardTools.from_env()
    return LlmAgent(
        name="board_assistant",
        description="Answers about the board, adds papers and notes to it, and searches for papers.",
        model=models.super_vl(),
        instruction=INSTRUCTION,
        tools=[
            board.canvas("get_board", "add_papers", "add_note", "link_papers"),
            SearchTool(search.build),
            *board.viewer(),
            board.plan(),
        ],
        before_tool_callback=clean_args,
    )
