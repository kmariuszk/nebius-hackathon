import json

from google.adk.agents import LlmAgent
from google.adk.runners import InMemoryRunner
from google.adk.tools.agent_tool import AgentTool
from google.genai import types

from conftest import ScriptedLlm, call, say
from harness.agents.master import agent as master


async def run(agent, text: str) -> list:
    runner = InMemoryRunner(agent=agent, app_name="test")
    session = await runner.session_service.create_session(app_name="test", user_id="ana")
    message = types.Content(role="user", parts=[types.Part(text=text)])
    try:
        return [e async for e in runner.run_async(user_id="ana", session_id=session.id, new_message=message)]
    finally:
        await runner.close()


def search_answer(sub_query: str, ids: list[str]) -> str:
    return json.dumps({"subQuery": sub_query, "candidates": [], "candidateIds": ids, "notes": ""})


async def test_master_searches_each_sub_query_then_reranks(papers_mcp):
    agent = master.build()
    search_tool = agent.tools[0]
    # Each search run answers in one turn, so the two parallel runs can take the turns in either order.
    search_tool.agent.model = ScriptedLlm(
        turns=[say(search_answer("a", ["pmid:1", "pmid:2"])), say(search_answer("b", ["pmid:2", "pmid:3"]))]
    )
    both_searches = types.Content(
        role="model",
        parts=[
            types.Part(function_call=types.FunctionCall(name="search", args={"request": "Sub-query: a. Seed paper IDs: doi:10.1/seed"})),
            types.Part(function_call=types.FunctionCall(name="search", args={"request": "Sub-query: b"})),
        ],
    )
    agent.model = model = ScriptedLlm(
        turns=[
            call("resolve_seed", doi="10.1/seed"),
            both_searches,
            call("rerank", goal="melanoma T cells", paper_ids=["pmid:2", "pmid:1", "pmid:3"], seed_ids=["doi:10.1/seed"], k=10),
            say("1. **Single-cell melanoma atlas**. Same cells."),
        ]
    )

    events = await run(agent, "Find papers on melanoma T cells. Seed: 10.1/seed")

    assert sorted(model.requests[0].tools_dict) == ["get_paper", "rerank", "resolve_seed", "search"]
    # Both search runs answer before the master's next turn, and it sees each one's candidates.
    responses = [p.function_response for p in model.requests[2].contents[-1].parts if p.function_response]
    assert [r.name for r in responses] == ["search", "search"]
    assert all("candidateIds" in json.dumps(r.response) for r in responses)
    assert papers_mcp.calls == [
        ("resolve_seed", {"doi": "10.1/seed", "pmid": None}),
        ("rerank", {"goal": "melanoma T cells", "paper_ids": ["pmid:2", "pmid:1", "pmid:3"], "seed_ids": ["doi:10.1/seed"], "k": 10}),
    ]
    assert "Single-cell melanoma atlas" in events[-1].content.parts[0].text


def test_master_runs_on_super_vl_with_the_search_agent_as_a_tool():
    agent = master.build()
    assert isinstance(agent, LlmAgent) and agent.name == "master"
    assert agent.model.model == "openai/nvidia/Nemotron-3.5-Super-VL"
    search_tool = agent.tools[0]
    assert isinstance(search_tool, AgentTool) and search_tool.agent.name == "search"
    assert search_tool.agent.model.model == "openai/nvidia/Nemotron-3_5-Lightning"
    assert agent.tools[1].tool_filter == ["resolve_seed", "get_paper", "rerank"]
    assert "Never invent" in agent.instruction
