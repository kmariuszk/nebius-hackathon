"""Prompt blocks to `genai` parts, ADK events to ACP updates, and the board tools' plumbing."""

import base64

from acp import embedded_blob_resource, embedded_text_resource, image_block, resource_block, resource_link_block, text_block
from acp.schema import HttpHeader, HttpMcpServer
from google.adk.events import Event
from google.genai import types

from harness.acp import prices
from harness.acp.adapter import canvas_server
from harness.acp.mapping import NO_IMAGES, EventMapper, to_genai_content
from harness.acp.trace import kind_of, summary
from harness.board.tools import BoardTools, NoTools

SHAPE = '{"id":"shape:paper-pmid_1","type":"paper-card","paperId":"pmid:1"}'
CHANGES = (
    '{"since":"2026-10-21T09:00:00.000Z","changes":['
    '{"type":"moved","paperId":"pmid:1","at":"2026-10-21T09:01:00.000Z"},'
    '{"type":"note_unpinned","text":"Same patients?","paperId":"pmid:2","at":"2026-10-21T09:02:00.000Z"},'
    '{"type":"note_removed","text":"Ask Igor","at":"2026-10-21T09:03:00.000Z"}]}'
)
PNG = base64.b64encode(b"\x89PNG fake").decode()


def test_prompt_blocks_become_tagged_parts():
    content = to_genai_content(
        [
            text_block("What links these?"),
            resource_block(embedded_text_resource("tldraw://b1/shape:paper-pmid_1", SHAPE, mime_type="application/vnd.tldraw.shape+json")),
            resource_block(embedded_text_resource("tldraw://b1/viewport", '{"x":0}', mime_type="application/json")),
            resource_block(embedded_text_resource("tldraw://b1/changes", CHANGES, mime_type="application/json")),
            resource_block(embedded_text_resource("https://example.org/notes", "some notes")),
            resource_block(embedded_blob_resource("tldraw://b1/blob", PNG, mime_type="image/png")),
            resource_link_block("paper", "https://pubmed.ncbi.nlm.nih.gov/1/"),
            text_block("The board as I see it:"),
            image_block(PNG, "image/png"),
        ]
    )
    texts = [p.text for p in content.parts]
    assert content.role == "user"
    assert texts[:8] == [
        "What links these?",
        f'<selected-shape uri="tldraw://b1/shape:paper-pmid_1">{SHAPE}</selected-shape>',
        '<viewport>{"x":0}</viewport>',
        f"<board-changes>{CHANGES}</board-changes>",
        '<board-context uri="https://example.org/notes">some notes</board-context>',
        '<board-context uri="tldraw://b1/blob">[binary, image/png]</board-context>',
        "https://pubmed.ncbi.nlm.nih.gov/1/",
        "The board as I see it:",
    ]
    image = content.parts[8].inline_data
    assert (image.mime_type, image.data) == ("image/png", b"\x89PNG fake")


def test_images_become_a_note_for_a_model_that_cannot_see():
    content = to_genai_content([text_block("Look:"), image_block(PNG, "image/png")], images=False)
    assert [p.text for p in content.parts] == ["Look:", NO_IMAGES]


def event(*parts: types.Part, partial: bool = False, id: str = "e1", **kwargs) -> Event:
    return Event(id=id, author="board_assistant", partial=partial, content=types.Content(role="model", parts=list(parts)), **kwargs)


def kinds_and_text(updates) -> list[tuple[str, str]]:
    return [(u.session_update, getattr(getattr(u, "content", None), "text", "")) for u in updates]


def test_partial_text_is_streamed_and_the_final_text_not_repeated():
    mapper = EventMapper(1000, lambda: 0.0)
    out = []
    out += mapper.updates(event(types.Part(text="Thinking about CD8.", thought=True), partial=True))
    out += mapper.updates(event(types.Part(text="Two "), partial=True))
    out += mapper.updates(event(types.Part(text="papers."), partial=True))
    out += mapper.updates(event(types.Part(text="Thinking about CD8.", thought=True), types.Part(text="Two papers.")))
    assert kinds_and_text(out) == [
        ("agent_thought_chunk", "Thinking about CD8."),
        ("agent_message_chunk", "Two "),
        ("agent_message_chunk", "papers."),
    ]


def test_a_final_event_without_partials_is_sent_whole():
    mapper = EventMapper(1000, lambda: 0.0)
    out = mapper.updates(event(types.Part(text="Hmm.", thought=True), types.Part(text="Done."), id="e2"))
    assert kinds_and_text(out) == [("agent_thought_chunk", "Hmm."), ("agent_message_chunk", "Done.")]


def test_update_plan_calls_become_a_plan_and_other_calls_nothing():
    mapper = EventMapper(1000, lambda: 0.0)
    entries = [{"content": "Search", "status": "in_progress"}, {"content": "Add", "status": "bogus", "priority": "high"}]
    plan_call = types.Part(function_call=types.FunctionCall(name="update_plan", args={"entries": entries}))
    other = types.Part(function_call=types.FunctionCall(name="add_papers", args={"papers": []}))
    [plan] = mapper.updates(event(plan_call, other))
    assert plan.session_update == "plan"
    assert [(e.content, e.status, e.priority) for e in plan.entries] == [
        ("Search", "in_progress", "medium"),
        ("Add", "pending", "high"),
    ]


def test_usage_and_errors():
    mapper = EventMapper(1_024_000, lambda: 0.0123)
    usage = types.GenerateContentResponseUsageMetadata(prompt_token_count=900, candidates_token_count=100, total_token_count=1000)
    [update] = mapper.updates(event(types.Part(text=""), usage_metadata=usage))
    assert (update.session_update, update.used, update.size) == ("usage_update", 1000, 1_024_000)
    assert (update.cost.amount, update.cost.currency) == (0.0123, "USD")

    aborted = Event(id="e3", author="board_assistant", error_code="INVOCATION_ABORTED", error_message="aborted")
    assert mapper.updates(aborted) == []
    broken = Event(id="e4", author="board_assistant", error_code="MALFORMED_FUNCTION_CALL", error_message="bad JSON")
    assert kinds_and_text(mapper.updates(broken)) == [("agent_message_chunk", "Something went wrong: bad JSON")]


def test_card_kinds_and_summaries():
    class Named:
        def __init__(self, name):
            self.name = name

    assert [kind_of(Named(n)) for n in ["get_board", "search", "find_candidates", "tavily-extract", "add_papers", "set_card", "done"]] == [
        "read", "search", "search", "fetch", "edit", "edit", "other"
    ]
    assert summary({"content": [{"type": "text", "text": '{"added": ["shape:paper-pmid_1"]}'}], "isError": False}) == '{"added": ["shape:paper-pmid_1"]}'
    assert summary({"error": "Fix these fields"}) == "Fix these fields"
    assert summary("x" * 500).endswith("…") and len(summary("x" * 500)) == 140


def test_prices_and_override(monkeypatch):
    assert prices.cost("nvidia/Nemotron-3.5-Super-VL", 1_000_000, 1_000_000) == 1.2
    assert prices.cost("unknown/model", 1000, 1000) == 0
    monkeypatch.setenv("MODEL_PRICES_JSON", '{"unknown/model": [1, 2]}')
    assert prices.cost("unknown/model", 1_000_000, 500_000) == 2


def test_canvas_server_from_session_new_with_the_internal_origin(monkeypatch):
    servers = [
        HttpMcpServer(type="http", name="other", url="http://x/mcp", headers=[]),
        HttpMcpServer(
            type="http",
            name="canvas",
            url="https://board.example/api/mcp/canvas/b1",
            headers=[HttpHeader(name="Authorization", value="Bearer m_ana")],
        ),
    ]
    monkeypatch.delenv("BOARD_INTERNAL_URL", raising=False)
    assert canvas_server(servers) == ("https://board.example/api/mcp/canvas/b1", {"Authorization": "Bearer m_ana"})
    monkeypatch.setenv("BOARD_INTERNAL_URL", "http://127.0.0.1:5858")
    url, headers = canvas_server(servers)
    assert url == "http://127.0.0.1:5858/api/mcp/canvas/b1"
    assert canvas_server([]) == (None, {})

    board = BoardTools.for_session(None, "s_1", url, headers)
    assert (board.board_id, board.member_id) == ("b1", "m_ana")
    canvas = board.canvas("add_papers")
    assert canvas._connection_params.url == url
    assert canvas._connection_params.headers == {"Authorization": "Bearer m_ana"}
    assert canvas.tool_filter == ["add_papers"]
    assert board.papers("search")._connection_params.headers == {"Authorization": "Bearer m_ana"}


def test_run_headers_carry_the_run_id_and_the_calling_agents_model():
    class Ctx:
        state = {"run_id": "run_0123456789ab"}
        agent_name = "board_assistant"

    board = BoardTools(canvas_url="http://board/api/mcp/canvas/b1")
    board.models["board_assistant"] = "nvidia/Nemotron-3.5-Super-VL"
    assert board.run_headers(Ctx()) == {"X-Run-Id": "run_0123456789ab", "X-Model": "nvidia/Nemotron-3.5-Super-VL"}
    assert board.viewer() == []
    assert board.plan().name == "update_plan"


def test_no_canvas_means_no_canvas_tools(monkeypatch):
    monkeypatch.delenv("CANVAS_MCP_URL", raising=False)
    assert isinstance(BoardTools.from_env().canvas("add_papers"), NoTools)
    monkeypatch.setenv("CANVAS_MCP_URL", "http://board/api/mcp/canvas/b1")
    monkeypatch.setenv("BOARD_TOKEN", "m_ben")
    canvas = BoardTools.from_env().canvas()
    assert canvas._connection_params.headers == {"Authorization": "Bearer m_ben"}
