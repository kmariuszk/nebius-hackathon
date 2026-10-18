"""The search agent: runs one sub-query and reports candidate papers.

The master splits the research question into about three sub-queries and
calls this agent once per sub-query (docs/Concept.md, Agent design). It only
finds candidates; `score_candidates` judges them afterwards.

Every turn must be a tool call, so the only way to finish is `done`, which
checks the answer, saves it to session state under `search_result` and ends
the run.
"""

from __future__ import annotations

from google.adk.agents import LlmAgent
from google.adk.tools import ToolContext
from google.genai import types
from pydantic import BaseModel, Field, ValidationError

from harness import models, toolsets

RESULT_KEY = "search_result"

INSTRUCTION = """\
You run one search sub-query for a literature discovery run and report the candidate papers you find. \
You do not rank papers; a scoring step does that later.

The request gives a sub-query. It may also list seed paper IDs (the researcher's starting papers) \
and paper IDs to exclude.

Every reply must be a tool call. Make at most 3 calls before `done`: `search` at most twice and \
`find_candidates` at most once.

1. Call `search` with the sub-query and `limit` 10. If few results look on-topic, call it once more \
with a broader rewording.
2. If the request lists seed paper IDs, call `find_candidates` with them and the IDs to exclude, \
to expand from the seeds through citations, similar articles and recommendations.
3. Call `done` with your answer, even if the results are thin; say so in `notes`. `done` ends the run.
- `candidates`: up to 15 papers from `search` that look on-topic, with why each fits the sub-query.
- `candidate_ids`: every on-topic ID from `search` plus every ID from `find_candidates`.
- `notes`: sources that failed or were skipped, thin results, or "".

Only report paper IDs and titles that a tool returned. Never invent them.
"""


class Candidate(BaseModel):
    paper_id: str = Field(serialization_alias="paperId")
    title: str
    found_by: list[str] = Field(serialization_alias="foundBy")
    why: str


class SearchResult(BaseModel):
    sub_query: str = Field(serialization_alias="subQuery")
    candidates: list[Candidate]
    candidate_ids: list[str] = Field(serialization_alias="candidateIds")
    notes: str


def done(
    sub_query: str,
    candidates: list[Candidate],
    candidate_ids: list[str],
    notes: str,
    tool_context: ToolContext,
) -> dict:
    """Report the candidate papers and end the run. Call this once, last.

    Args:
        sub_query: The sub-query you ran.
        candidates: Up to 15 on-topic papers from `search`, each with paper_id, title,
            found_by and why (a short phrase on how it fits the sub-query).
        candidate_ids: Every on-topic ID from `search` plus every ID from `find_candidates`.
        notes: Sources that failed or were skipped, thin results, or "".
    """
    try:
        result = SearchResult(
            sub_query=sub_query, candidates=candidates, candidate_ids=candidate_ids, notes=notes
        )
    except ValidationError as error:
        return {"error": f"Fix these fields and call done again: {error}"}
    answer = result.model_dump(by_alias=True)
    tool_context.state[RESULT_KEY] = answer
    # The answer is the final response; the model is not called again.
    tool_context.actions.skip_summarization = True
    return answer


def build() -> LlmAgent:
    return LlmAgent(
        name="search",
        description=(
            "Runs one search sub-query over PubMed, OpenAlex and the web, optionally expanding "
            "from seed papers, and returns candidate paper IDs. Input: the sub-query, plus any "
            "seed paper IDs and IDs to exclude."
        ),
        model=models.lightning(),
        instruction=INSTRUCTION,
        tools=[toolsets.papers("search", "find_candidates"), done],
        # Forces a tool call every turn (tool_choice "required"), so a plain text
        # reply cannot end the run early; only `done` does.
        generate_content_config=types.GenerateContentConfig(
            tool_config=types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    mode=types.FunctionCallingConfigMode.ANY
                )
            )
        ),
    )


root_agent = build()
