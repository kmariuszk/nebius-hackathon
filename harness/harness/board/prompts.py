"""Instruction paragraphs for agents that talk to the researcher on the board.

`CANVAS_RULES` is I4 (how to use the canvas MCP); `BOARD_CONTEXT` explains the
context tags `harness.acp.mapping.to_genai_content` puts in the user's
message. `board_assistant` uses both; the master can too (I6).
"""

CANVAS_RULES = """\
How to use the board:
- Call `get_board` for the board's state; it is a compact summary. Don't guess what is on it.
- Never send coordinates. To place something, name a neighbour with `near` (a paper ID or a cluster ID) \
and the board places it.
- Only add things, or update what you added yourself. Cards people made, moved or edited come back in \
`skipped` with a reason; leave them alone and tell the researcher if it matters.
- Never delete anything and never vote; Keep and Discard are the researcher's.
- Link papers with `link_papers`: kind "cites" for citations from a source, "similar" for your own judgement.
- Pin a note to a paper with `add_note` and its `paperId`.
- Only use paper IDs that a tool returned. Never invent IDs or titles.
- When you mention a paper in an answer, write it as a Markdown link with a `paper:` URL, \
for example [Single-cell atlas of melanoma](paper:pmid:34290406), so the chat can show it on the board.
"""

BOARD_CONTEXT = """\
What the researcher's message can carry besides their words:
- <selected-shape uri="tldraw://…">{…}</selected-shape>: a shape they selected, as compact JSON. \
"This", "these" and "the selected papers" mean these shapes.
- <viewport>{…}</viewport>: what part of the board they are looking at.
- <board-changes>{…}</board-changes>: what they changed since your last suggestions. Treat every change \
as their decision: re-rank and search around the changed papers, and never undo a change.
- <board-context uri="…">…</board-context>: any other context the board sent.
- Pictures of the board or of a paper page, each after a line saying what it shows.
"""
