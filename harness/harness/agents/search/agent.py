"""The search agent: runs one sub-query and reports candidate papers.

The master splits the research question into about three sub-queries and
calls this agent once per sub-query (docs/Concept.md, Agent design). It only
finds candidates; `score_candidates` judges them afterwards.

The run finishes with `done`, which checks the answer, saves it to session
state under `search_result` and ends the run.

Tool calls are not forced. With `tool_choice: "required"`, Lightning on Token
Factory never stopped after a call: every reply ran to the token cap with a
search and dozens of `done` calls. Without it, Lightning makes one call per
reply and reads each result before the next.
"""

from __future__ import annotations

from google.adk.agents import LlmAgent
from google.adk.agents.callback_context import CallbackContext
from google.adk.models.llm_response import LlmResponse
from google.adk.tools import ToolContext
from google.genai import types
from pydantic import BaseModel, Field, ValidationError

from harness import models, toolsets

RESULT_KEY = "search_result"
# Room for the reasoning and `done` with 15 candidates. Lightning otherwise keeps repeating calls up to its 8192 cap.
MAX_REPLY_TOKENS = 4096

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
- `seed_candidates`: how many IDs `find_candidates` returned, or 0 if you didn't call it.
- `notes`: sources that failed or were skipped, thin results, or "".
Every ID the tools return is collected for ranking automatically, so don't list them all.

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
    seed_candidates: int = Field(ge=0, serialization_alias="seedCandidates")
    notes: str


def done(
    sub_query: str,
    candidates: list[Candidate],
    seed_candidates: int,
    notes: str,
    tool_context: ToolContext,
) -> dict:
    """Report the candidate papers and end the run. Call this once, last.

    Args:
        sub_query: The sub-query you ran.
        candidates: Up to 15 on-topic papers from `search`, each with paper_id, title,
            found_by and why (a short phrase on how it fits the sub-query).
        seed_candidates: How many IDs `find_candidates` returned, or 0 if you didn't call it.
        notes: Sources that failed or were skipped, thin results, or "".
    """
    try:
        result = SearchResult(
            sub_query=sub_query, candidates=candidates, seed_candidates=seed_candidates, notes=notes
        )
    except ValidationError as error:
        return {"error": f"Fix these fields and call done again: {error}"}
    answer = result.model_dump(by_alias=True)
    tool_context.state[RESULT_KEY] = answer
    # The answer is the final response; the model is not called again.
    tool_context.actions.skip_summarization = True
    return answer


def first_call_only(callback_context: CallbackContext, llm_response: LlmResponse) -> LlmResponse | None:
    """Keep only the first tool call of a reply.

    Lightning packs `search`, `find_candidates` and dozens of `done` calls into one reply. Run together,
    `done` reports before any search result exists, so the agent takes one step per reply instead.
    """
    parts = llm_response.content.parts if llm_response.content else None
    calls = [p for p in parts or [] if p.function_call]
    if len(calls) < 2:
        return None
    llm_response.content.parts = [p for p in parts if not p.function_call or p is calls[0]]
    # the token cap cut the dropped calls, not the one that runs
    llm_response.error_code = llm_response.error_message = None
    return llm_response


def build() -> LlmAgent:
    return LlmAgent(
        name="search",
        description=(
            "Runs one search sub-query over PubMed, OpenAlex and the web, optionally expanding "
            "from seed papers, and reports its picks; every ID its tools return goes to the "
            "master's candidate pool. Input: the sub-query, plus any seed paper IDs and IDs "
            "to exclude."
        ),
        model=models.lightning(),
        instruction=INSTRUCTION,
        tools=[toolsets.papers("search", "find_candidates"), done],
        after_model_callback=first_call_only,
        # No forced tool choice (see the module docstring); the cap stays as a backstop.
        generate_content_config=types.GenerateContentConfig(max_output_tokens=MAX_REPLY_TOKENS),
    )


root_agent = build()
