import json

from google.adk.runners import InMemoryRunner
from google.genai import types

from conftest import ScriptedLlm, call, say
from harness.agents.reader import agent as reader


async def run(agent, text: str) -> list:
    runner = InMemoryRunner(agent=agent, app_name="test")
    session = await runner.session_service.create_session(app_name="test", user_id="ana")
    message = types.Content(role="user", parts=[types.Part(text=text)])
    try:
        return [e async for e in runner.run_async(user_id="ana", session_id=session.id, new_message=message)]
    finally:
        await runner.close()


async def test_reader_reads_the_full_text_and_checks_its_quotes(papers_mcp):
    quotes = ["TOX marked every exhausted clone.", "TOX marks all exhausted clones."]
    artifacts = {
        "paperId": "pmid:1",
        "source": "pmc",
        "tldr": "TOX marks exhausted T cell clones in melanoma.",
        "summary": "They profiled 40,000 T cells from 12 melanomas.",
        "rewrittenAbstract": "…",
        "highlights": [{"text": quotes[0], "section": "Results", "category": "result", "note": "The main finding."}],
        "quotes": [{"text": quotes[0], "section": "Results", "link": "https://pmc/PMC1/#:~:text=TOX marked"}],
        "figures": [{"figureId": "F2", "label": "Figure 2", "why": "Shows TOX by state."}],
        "notes": "",
    }
    agent = reader.build()
    agent.model = model = ScriptedLlm(
        turns=[
            call("get_fulltext", paper_id="pmid:1"),
            call("check_quotes", paper_id="pmid:1", quotes=quotes),
            say(json.dumps(artifacts)),
        ]
    )

    events = await run(agent, "Paper ID: pmid:1")

    assert sorted(model.requests[0].tools_dict) == ["check_quotes", "get_fulltext"]
    assert [name for name, _ in papers_mcp.calls] == ["get_fulltext", "check_quotes"]
    # The model sees the sections and figures, then which passages are verbatim.
    fulltext = model.requests[1].contents[-1].parts[0].function_response.response
    assert "TOX marked every exhausted clone." in json.dumps(fulltext) and "F2" in json.dumps(fulltext)
    checked = json.dumps(model.requests[2].contents[-1].parts[0].function_response.response)
    assert '"verbatim": true' in checked and '"verbatim": false' in checked
    assert json.loads(events[-1].content.parts[0].text) == artifacts


def test_reader_runs_on_super_vl_and_never_invents():
    agent = reader.build()
    assert agent.name == "reader"
    assert agent.model.model == "openai/nvidia/Nemotron-3.5-Super-VL"
    assert agent.tools[0].tool_filter == ["get_fulltext", "check_quotes"]
    assert "Never invent" in agent.instruction
