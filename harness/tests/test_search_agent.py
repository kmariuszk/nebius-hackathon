import json

from google.adk.runners import InMemoryRunner
from google.genai import types

from conftest import ScriptedLlm, call, say
from harness.agents.search import agent as search


async def run(agent, text: str) -> list:
    runner = InMemoryRunner(agent=agent, app_name="test")
    session = await runner.session_service.create_session(app_name="test", user_id="ana")
    message = types.Content(role="user", parts=[types.Part(text=text)])
    try:
        events = [e async for e in runner.run_async(user_id="ana", session_id=session.id, new_message=message)]
        session = await runner.session_service.get_session(app_name="test", user_id="ana", session_id=session.id)
        return events, session.state
    finally:
        await runner.close()


CANDIDATE = {"paper_id": "pmid:1", "title": "Single-cell melanoma atlas", "found_by": ["pubmed"], "why": "atlas"}


async def test_search_agent_calls_the_papers_mcp_and_finishes_with_done(papers_mcp):
    agent = search.build()
    agent.model = model = ScriptedLlm(
        turns=[
            call("search", query="melanoma T cells", limit=10),
            call("find_candidates", seed_ids=["pmid:9"]),
            call(
                "done",
                sub_query="melanoma T cells",
                candidates=[CANDIDATE],
                seed_candidates=1,
                notes="",
            ),
        ]
    )

    events, state = await run(agent, "Sub-query: melanoma T cells. Seeds: pmid:9")

    assert papers_mcp.calls == [
        ("search", {"query": "melanoma T cells", "limit": 10}),
        ("find_candidates", {"seed_ids": ["pmid:9"]}),
    ]
    # The agent only sees the tools it asked for, plus done, not the server's whole list.
    assert sorted(model.requests[0].tools_dict) == ["done", "find_candidates", "search"]
    # Each tool result goes back to the model on the next turn.
    responses = [p.function_response for p in model.requests[1].contents[-1].parts if p.function_response]
    assert responses[0].name == "search"
    assert "Single-cell melanoma atlas" in json.dumps(responses[0].response)
    # done ends the run: the model is not called again, and the answer is in state.
    assert len(model.requests) == 3
    assert events[-1].is_final_response()
    assert state[search.RESULT_KEY] == {
        "subQuery": "melanoma T cells",
        "candidates": [{"paperId": "pmid:1", "title": "Single-cell melanoma atlas", "foundBy": ["pubmed"], "why": "atlas"}],
        "seedCandidates": 1,
        "notes": "",
    }


async def test_done_with_a_bad_answer_asks_the_model_to_fix_it(papers_mcp):
    agent = search.build()
    agent.model = model = ScriptedLlm(
        turns=[
            call("done", sub_query="melanoma T cells", candidates=[{"title": "no id"}], seed_candidates=0, notes=""),
            call("done", sub_query="melanoma T cells", candidates=[], seed_candidates=0, notes="no results"),
        ]
    )

    _, state = await run(agent, "Sub-query: melanoma T cells")

    error = model.requests[1].contents[-1].parts[0].function_response.response
    assert "call done again" in error["error"]
    assert state[search.RESULT_KEY]["notes"] == "no results"


async def test_a_reply_with_many_calls_runs_only_the_first(papers_mcp):
    # Lightning packs a search, then dozens of `done` calls, into one reply until it hits the token cap.
    many = call("search", query="melanoma T cells", limit=10)
    empty_done = call("done", sub_query="melanoma T cells", candidates=[], seed_candidates=0, notes="none")
    many.parts += empty_done.parts * 3
    agent = search.build()
    agent.model = model = ScriptedLlm(
        turns=[many, call("done", sub_query="melanoma T cells", candidates=[CANDIDATE], seed_candidates=0, notes="")]
    )

    _, state = await run(agent, "Sub-query: melanoma T cells")

    assert papers_mcp.calls == [("search", {"query": "melanoma T cells", "limit": 10})]
    assert [p.function_response.name for p in model.requests[1].contents[-1].parts] == ["search"]
    assert state[search.RESULT_KEY]["candidates"][0]["paperId"] == "pmid:1"


def test_search_agent_replies_are_capped():
    assert search.build().generate_content_config.max_output_tokens == search.MAX_REPLY_TOKENS


def test_search_agent_must_call_a_tool_every_turn():
    config = search.build().generate_content_config.tool_config.function_calling_config
    assert config.mode == types.FunctionCallingConfigMode.ANY


def test_search_agent_runs_on_lightning():
    agent = search.build()
    assert agent.name == "search"
    assert agent.model.model == "openai/nvidia/Nemotron-3_5-Lightning"
    assert "Never invent" in agent.instruction
    assert "at most 3 calls before `done`" in agent.instruction
