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
        return [e async for e in runner.run_async(user_id="ana", session_id=session.id, new_message=message)]
    finally:
        await runner.close()


async def test_search_agent_calls_the_papers_mcp_and_answers_in_json(papers_mcp):
    answer = {"subQuery": "melanoma T cells", "candidates": [], "seedCandidates": 1, "notes": ""}
    agent = search.build()
    agent.model = model = ScriptedLlm(
        turns=[
            call("search", query="melanoma T cells"),
            call("find_candidates", seed_ids=["pmid:9"]),
            say(json.dumps(answer)),
        ]
    )

    events = await run(agent, "Sub-query: melanoma T cells. Seeds: pmid:9")

    assert papers_mcp.calls == [
        ("search", {"query": "melanoma T cells", "limit": 20}),
        ("find_candidates", {"seed_ids": ["pmid:9"]}),
    ]
    # The agent only sees the tools it asked for, not the server's whole list.
    assert sorted(model.requests[0].tools_dict) == ["find_candidates", "search"]
    # Each tool result goes back to the model on the next turn.
    responses = [p.function_response for p in model.requests[1].contents[-1].parts if p.function_response]
    assert responses[0].name == "search"
    assert "Single-cell melanoma atlas" in json.dumps(responses[0].response)
    assert json.loads(events[-1].content.parts[0].text) == answer


def test_search_agent_runs_on_lightning():
    agent = search.build()
    assert agent.name == "search"
    assert agent.model.model == "openai/nvidia/Nemotron-3_5-Lightning"
    assert "Never invent" in agent.instruction
