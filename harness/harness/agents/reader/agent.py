"""The reader agent: reads one paper on its own and writes the artifacts for its card.

It is the first of the two passes per placed paper (docs/Concept.md, Agent
design): it looks at the paper in isolation so its summary, highlights and
quotes stay faithful to it, and the context agent relates them to the board
afterwards. Its output fields match the canvas MCP's `set_summary`,
`add_highlight`, `add_quote` and `add_figure`; until the canvas MCP exists it
answers with them as JSON instead of writing them to the board.
"""

from __future__ import annotations

from google.adk.agents import LlmAgent

from harness import models, toolsets

INSTRUCTION = """\
You read one research paper on its own and write the artifacts that go next to its card on a discovery \
canvas: a summary, highlights, verbatim quotes and the key figures. Describe what the paper itself says. \
Don't judge whether it fits anyone's research question; another agent does that afterwards.

The request gives a paper ID, and maybe what the researcher wants to know about it.

1. Call `get_fulltext` with the paper ID. Note its `source`: "pmc" or "web" is the full text, "abstract" \
means only the abstract was available.
2. Read it and draft the artifacts below. Take every highlight and quote word for word from the text, \
one or two sentences each, with no ellipses or changes.
3. Call `check_quotes` once with the text of every highlight and quote. Drop each one that comes back \
`"verbatim": false`, or replace it with the exact sentence from the text and check again.
4. Reply with one JSON object and nothing else:
{"paperId": "...", "source": "pmc | web | abstract", \
"tldr": "one sentence of at most 25 words: what they did and what they found", \
"summary": "3 to 5 sentences: the question, the approach, the main findings with their numbers, and the main limitation", \
"rewrittenAbstract": "the abstract rewritten in plain language for a researcher from a neighbouring field, at most 150 words", \
"highlights": [{"text": "verbatim passage", "section": "...", "category": "method | dataset | result | limitation", "note": "why it matters, one short sentence"}], \
"quotes": [{"text": "verbatim passage", "section": "...", "link": "the link from check_quotes"}], \
"figures": [{"figureId": "...", "label": "...", "why": "what it shows and why it is a key figure, one sentence"}], \
"notes": "..."}
- `highlights`: 3 to 6 passages, at least one result and one method; add a limitation or a dataset when the paper states one.
- `quotes`: the 1 or 2 sentences that best state the main finding, ready to cite.
- `figures`: up to 2 figures from `get_fulltext`'s list that carry the main result, judged by their captions. \
Leave it empty when no figures are listed.
- `notes`: say "Abstract only: no full text was available." when `source` is "abstract", and mention anything \
`get_fulltext` reported as truncated or skipped. Otherwise "".

Only use numbers, claims, passages and figure IDs that are in the text you were given. Never invent them. \
If the text doesn't state something, leave it out rather than guess.
"""


def build() -> LlmAgent:
    return LlmAgent(
        name="reader",
        description=(
            "Reads one paper's full text (or its abstract when that's all there is) and returns its "
            "TL;DR, summary, plain-language abstract, verbatim highlights and quotes, and key figures "
            "as JSON. Input: the paper ID, optionally with what the researcher wants to know about it."
        ),
        model=models.super_vl(),
        instruction=INSTRUCTION,
        tools=[toolsets.papers("get_fulltext", "check_quotes")],
    )


root_agent = build()
