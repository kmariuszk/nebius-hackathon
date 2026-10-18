import json

from google.adk.agents import LlmAgent
from google.adk.runners import InMemoryRunner
from google.genai import types

from conftest import ScriptedLlm, call, say
from harness.agents.master import agent as master
from harness.agents.master import candidates
from harness.agents.search import agent as search


async def run(runner: InMemoryRunner, session_id: str, text: str) -> list:
    message = types.Content(role="user", parts=[types.Part(text=text)])
    return [e async for e in runner.run_async(user_id="ana", session_id=session_id, new_message=message)]


def scripted_search(query: str, seeds: list[str] | None = None) -> LlmAgent:
    """A search agent that calls `search` (and `find_candidates` with seeds), then answers."""
    turns = [call("search", query=query)]
    if seeds:
        turns.append(call("find_candidates", seed_ids=seeds))
    answer = {"subQuery": query, "candidates": [], "seedCandidates": len(seeds or []), "notes": ""}
    agent = search.build()
    agent.model = ScriptedLlm(turns=[*turns, say(json.dumps(answer))])
    return agent


def parallel(*requests: str) -> types.Content:
    parts = [types.Part(function_call=types.FunctionCall(name="search", args={"request": r})) for r in requests]
    return types.Content(role="model", parts=parts)


async def test_parallel_searches_feed_rerank_their_real_ids(papers_mcp):
    # Each search call gets a fresh agent: the slow sub-query is still in its MCP call when the
    # fast one finishes and closes its own toolset, which must not cut the slow one off.
    scripts = iter(
        [
            search.build,  # The template SearchTool builds once for its declaration.
            lambda: scripted_search("slow melanoma T cells", seeds=["doi:10.1/seed"]),
            lambda: scripted_search("spatial exhaustion"),
            lambda: scripted_search("spatial niches"),
        ]
    )
    agent = master.build(search_agent=lambda: next(scripts)())
    agent.model = model = ScriptedLlm(
        turns=[
            call("resolve_seed", doi="10.1/seed"),
            parallel("Sub-query: slow melanoma T cells. Seed paper IDs: doi:10.1/seed", "Sub-query: spatial exhaustion"),
            # The model copies an ID wrong; the pool replaces it with the IDs the tools returned.
            call("rerank", goal="melanoma T cells", paper_ids=["doi:1136/mangled"], seed_ids=["doi:10.1/seed"], k=10),
            say("1. **Single-cell melanoma atlas**. Same cells."),
            # Follow-up: drop a paper, search a new angle, rerank everything found so far.
            parallel("Sub-query: spatial niches"),
            call("rerank", goal="melanoma T cells, spatial", paper_ids=[], exclude_ids=["pmid:2"], k=5),
            say("Reranked."),
        ]
    )
    runner = InMemoryRunner(agent=agent, app_name="test")
    session = await runner.session_service.create_session(app_name="test", user_id="ana")
    try:
        first = await run(runner, session.id, "Find papers on melanoma T cells. Seed: 10.1/seed")
        await run(runner, session.id, "Drop pmid:2 and look at spatial niches")
    finally:
        await runner.close()

    assert sorted(model.requests[0].tools_dict) == ["get_paper", "rerank", "resolve_seed", "search"]
    # Both search runs finish before the master's next turn, with no MCP errors.
    responses = [p.function_response for p in model.requests[2].contents[-1].parts if p.function_response]
    assert [r.name for r in responses] == ["search", "search"]
    assert all('"seedCandidates"' in r.response["result"] for r in responses)
    searched = [args["query"] for name, args in papers_mcp.calls if name == "search"]
    assert sorted(searched) == ["slow melanoma T cells", "spatial exhaustion", "spatial niches"]

    reranks = [args for name, args in papers_mcp.calls if name == "rerank"]
    # pmid:1 (slow search), pmid:2 (find_candidates) and pmid:3 (spatial) each came from one result.
    assert sorted(reranks[0]["paper_ids"]) == ["pmid:1", "pmid:2", "pmid:3"]
    assert reranks[0]["seed_ids"] == ["doi:10.1/seed"]
    # The second spatial search found pmid:3 again, so it now leads; the exclusion passes through.
    assert reranks[1]["paper_ids"][0] == "pmid:3" and sorted(reranks[1]["paper_ids"]) == ["pmid:1", "pmid:2", "pmid:3"]
    assert reranks[1]["exclude_ids"] == ["pmid:2"]
    assert "Single-cell melanoma atlas" in first[-1].content.parts[0].text


def test_pool_orders_by_how_many_results_found_a_paper():
    state = {
        "candidates:a:0": ["pmid:1", "pmid:2", "pmid:3"],
        "candidates:b:0": ["pmid:4", "pmid:3"],
        "other": ["pmid:9"],
    }
    # pmid:3 is in two results; the rest interleave by position across results.
    assert candidates.pool(state) == ["pmid:3", "pmid:1", "pmid:4", "pmid:2"]


def test_ids_come_from_structured_or_text_results():
    structured = {"structuredContent": {"papers": [{"paperId": "pmid:1"}, {"title": "no id"}]}}
    text = {"content": [{"type": "text", "text": json.dumps({"candidateIds": ["pmid:2"]})}]}
    assert candidates.paper_ids("search", structured) == ["pmid:1"]
    assert candidates.paper_ids("find_candidates", text) == ["pmid:2"]
    assert candidates.paper_ids("get_paper", structured) == []


def test_master_runs_on_super_vl_with_the_search_agent_as_a_tool():
    agent = master.build()
    assert isinstance(agent, LlmAgent) and agent.name == "master"
    assert agent.model.model == "openai/nvidia/Nemotron-3.5-Super-VL"
    search_tool = agent.tools[0]
    assert isinstance(search_tool, candidates.SearchTool) and search_tool.agent.name == "search"
    assert search_tool.agent.model.model == "openai/nvidia/Nemotron-3_5-Lightning"
    assert agent.tools[1].tool_filter == ["resolve_seed", "get_paper", "rerank"]
    assert "Never invent" in agent.instruction
