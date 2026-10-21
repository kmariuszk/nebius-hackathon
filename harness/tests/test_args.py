import logging
from types import SimpleNamespace

import pytest
from google.adk.tools import FunctionTool
from google.adk.tools.mcp_tool.mcp_tool import McpTool
from mcp.types import Tool

from harness.agents.args import PLACEHOLDERS, chain, clean_args
from harness.agents.context import agent as context
from harness.agents.master import agent as master
from harness.agents.reader import agent as reader
from harness.agents.search import agent as search
from harness.board import assistant
from harness.board.tools import BoardTools


def mcp_tool(name: str, *required: str) -> McpTool:
    """An MCP tool as the toolset gives it, with no server behind it."""
    schema = {"type": "object", "properties": {}, "required": list(required)}
    return McpTool(mcp_tool=Tool(name=name, input_schema=schema), mcp_session_manager=None)


SEARCH = mcp_tool("search", "query")
BOARD = BoardTools("b_1", "m_ana", "http://board/api/mcp/canvas/b_1", {"Authorization": "Bearer m_ana"})


def test_placeholders_are_the_shared_list():
    assert PLACEHOLDERS == {"None", "none", "null", "NULL", "undefined", ""}


@pytest.mark.parametrize("placeholder", ["None", "none", "null", "NULL", "undefined", ""])
def test_an_optional_argument_written_as_a_placeholder_is_dropped(placeholder):
    args = {"query": "melanoma T cells", "since": placeholder, "sources": placeholder, "limit": 10}
    assert clean_args(tool=SEARCH, args=args, tool_context=None) is None
    assert args == {"query": "melanoma T cells", "limit": 10}


def test_required_arguments_and_real_values_are_kept():
    # The server's validation error tells the model what to fix; fill() replaces the empty lists.
    args = {"query": "None", "paper_ids": [], "filters": {}, "since": "2020", "limit": 0}
    clean_args(tool=SEARCH, args=args, tool_context=None)
    assert args == {"query": "None", "paper_ids": [], "filters": {}, "since": "2020", "limit": 0}


def test_function_tools_are_untouched():
    args = {"sub_query": "melanoma T cells", "candidates": [], "seed_candidates": 0, "notes": ""}
    clean_args(tool=FunctionTool(search.done), args=args, tool_context=None)
    assert args["notes"] == ""


def test_each_dropped_argument_is_logged(caplog):
    caplog.set_level(logging.DEBUG, logger="harness.agents.args")
    clean_args(tool=SEARCH, args={"query": "q", "since": "None", "sources": "null"}, tool_context=None)
    assert [(r.levelname, r.getMessage()) for r in caplog.records] == [
        ("DEBUG", 'dropped since="None" from search'),
        ("DEBUG", 'dropped sources="null" from search'),
        ("INFO", "search: dropped 2 placeholder arguments: since, sources"),
    ]


def test_chain_runs_callbacks_in_order_and_stops_at_the_first_dict():
    seen = []

    def mark(*, tool, args, tool_context):
        seen.append("mark")
        args["marked"] = True

    def refuse(*, tool, args, tool_context):
        seen.append("refuse")
        return {"error": "No."}

    def never(*, tool, args, tool_context):
        seen.append("never")

    args = {}
    assert chain(mark, refuse, never)(tool=SEARCH, args=args, tool_context=None) == {"error": "No."}
    assert seen == ["mark", "refuse"] and args == {"marked": True}
    assert chain(mark, mark)(tool=SEARCH, args={}, tool_context=None) is None


def test_every_agent_cleans_its_tool_arguments():
    for agent in (search.build(), reader.build(), context.build(BOARD), assistant.build(BOARD)):
        assert agent.before_tool_callback is clean_args, agent.name


def test_the_master_cleans_before_it_fills_in_ids():
    # A pool from earlier searches; the model wrote "None" for rerank's optional exclude_ids.
    state = {"candidates:c1:0": ["pmid:1", "pmid:3"]}
    tool_context = SimpleNamespace(state=SimpleNamespace(to_dict=lambda: state))
    rerank = mcp_tool("rerank", "goal", "paper_ids")

    args = {"goal": "melanoma T cells", "paper_ids": [], "exclude_ids": "None"}
    master.build().before_tool_callback(tool=rerank, args=args, tool_context=tool_context)
    assert args == {"goal": "melanoma T cells", "paper_ids": ["pmid:1", "pmid:3"]}

    # On a board, fill() merges exclude_ids with the discarded papers; "None" would become N, e, n, o.
    args = {"goal": "melanoma T cells", "paper_ids": [], "exclude_ids": "None"}
    master.build(BOARD).before_tool_callback(tool=rerank, args=args, tool_context=tool_context)
    assert args == {"goal": "melanoma T cells", "paper_ids": ["pmid:1", "pmid:3"], "exclude_ids": []}
