"""The search agent: runs one sub-query and reports candidate papers.

The master splits the research question into about three sub-queries and
calls this agent once per sub-query (docs/Concept.md, Agent design). It only
finds candidates; `score_candidates` judges them afterwards.
"""

from __future__ import annotations

from google.adk.agents import LlmAgent

from harness import models, toolsets

INSTRUCTION = """\
You run one search sub-query for a literature discovery run and report the candidate papers you find. \
You do not rank papers; a scoring step does that later.

The request gives a sub-query. It may also list seed paper IDs (the researcher's starting papers) \
and paper IDs to exclude.

1. Call `search` with the sub-query. If few results look on-topic, call it once more with a broader rewording.
2. If the request lists seed paper IDs, call `find_candidates` with them and the IDs to exclude, \
to expand from the seeds through citations, similar articles and recommendations.
3. Reply with one JSON object and nothing else:
{"subQuery": "...", "candidates": [{"paperId": "...", "title": "...", "foundBy": ["..."], "why": "a short phrase"}], \
"seedCandidates": 0, "notes": "..."}
- `candidates`: up to 15 papers from `search` that look on-topic, with why each fits the sub-query.
- `seedCandidates`: how many IDs `find_candidates` returned, or 0 if you didn't call it.
- `notes`: sources that failed or were skipped, or "".
Every ID the tools return is collected for ranking automatically, so don't list them all.

Only report paper IDs and titles that a tool returned. Never invent them.
"""


def build() -> LlmAgent:
    return LlmAgent(
        name="search",
        description=(
            "Runs one search sub-query over PubMed, OpenAlex and the web, optionally expanding "
            "from seed papers, and returns candidate paper IDs as JSON. Input: the sub-query, "
            "plus any seed paper IDs and IDs to exclude."
        ),
        model=models.lightning(),
        instruction=INSTRUCTION,
        tools=[toolsets.papers("search", "find_candidates")],
    )


root_agent = build()
