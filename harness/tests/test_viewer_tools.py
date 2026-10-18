"""The viewer tools (T06): each sends its `_canvas/*` notification to its own ACP session only.

The params must match what the browser parses (`client/shared/acpExt.ts`):
`shapeIds` / `paperIds`, `durationMs`, and tour steps `[{paperId, line}]`.
"""

import json
from pathlib import Path

from acp import text_block

from fixtures.acp_client import harness
from harness.board.tools import VIEWER_TOOLS, BoardTools

TESTS = Path(__file__).parent
STEPS = [{"paper_id": "pmid:1", "line": "The atlas your seeds build on."}, {"paper_id": "pmid:2", "line": "New spatial data."}]
WIRE_STEPS = [{"paperId": "pmid:1", "line": "The atlas your seeds build on."}, {"paperId": "pmid:2", "line": "New spatial data."}]


class Conn:
    """Records ext notifications like the ACP connection would send them."""

    def __init__(self, gone: bool = False) -> None:
        self.sent: list[tuple[str, dict]] = []
        self.gone = gone

    async def ext_notification(self, method: str, params: dict) -> None:
        if self.gone:
            raise ConnectionError("Connection closed")
        self.sent.append((method, params))


def tools(conn: Conn, session_id: str) -> dict:
    return {tool.name: tool.func for tool in BoardTools(conn=conn, session_id=session_id).viewer()}


async def test_each_tool_sends_its_notification_with_the_browsers_params():
    conn = Conn()
    viewer = tools(conn, "s_ana")
    assert set(viewer) == VIEWER_TOOLS  # the names the trace plugin hides

    assert await viewer["focus"](paper_ids=["pmid:1"], shape_ids=["shape:note-1"]) == {"ok": True}
    assert await viewer["highlight"](paper_ids=["pmid:1", "pmid:2"], seconds=3) == {"ok": True}
    assert await viewer["open_paper"](paper_id="pmid:1") == {"ok": True}
    assert await viewer["tour"](steps=STEPS) == {"ok": True}
    assert conn.sent == [
        ("canvas/focus", {"sessionId": "s_ana", "paperIds": ["pmid:1"], "shapeIds": ["shape:note-1"]}),
        ("canvas/highlight", {"sessionId": "s_ana", "paperIds": ["pmid:1", "pmid:2"], "durationMs": 3000}),
        ("canvas/open_paper", {"sessionId": "s_ana", "paperId": "pmid:1"}),
        ("canvas/tour", {"sessionId": "s_ana", "title": "Catch-up", "steps": WIRE_STEPS}),
    ]


async def test_nothing_to_point_at_sends_nothing():
    conn = Conn()
    viewer = tools(conn, "s_ana")
    assert (await viewer["focus"]())["ok"] is False
    assert (await viewer["highlight"](paper_ids=[], shape_ids=[]))["ok"] is False
    assert (await viewer["tour"](steps=[]))["ok"] is False
    assert conn.sent == []


async def test_a_closed_chat_tells_the_model_instead_of_failing_the_turn():
    viewer = tools(Conn(gone=True), "s_ana")
    assert await viewer["open_paper"](paper_id="pmid:1") == {
        "ok": False,
        "error": "The researcher's browser is no longer connected.",
    }


def test_without_a_chat_there_is_no_screen_to_point_at(monkeypatch):
    monkeypatch.delenv("CANVAS_MCP_URL", raising=False)
    assert BoardTools.from_env().viewer() == []
    assert BoardTools(conn=Conn()).viewer() == []


def call(name: str, **args) -> dict:
    return {"calls": [{"name": name, "args": args}]}


async def test_two_sessions_each_get_only_their_own_notifications(tmp_path):
    # Each session builds its own agent, so both replay the whole script.
    script = {
        "board_assistant": [
            {"text": "Here is the atlas. ", **call("focus", paper_ids=["pmid:1"])},
            call("highlight", paper_ids=["pmid:1"], shape_ids=["shape:note-1"], seconds=4),
            call("open_paper", paper_id="pmid:1"),
            call("tour", steps=STEPS, title="Since Friday"),
            {"text": "That's all."},
        ]
    }
    path = tmp_path / "script.json"
    path.write_text(json.dumps(script))
    env = {"HARNESS_MODEL": f"scripted:{path}", "HARNESS_AGENT": "board_assistant", "TF_API_KEY": "", "PYTHONPATH": str(TESTS)}
    async with harness(env=env) as h:
        ana = await h.start(member="m_ana")
        ben = await h.start(member="m_ben")
        first = await h.conn.prompt(session_id=ana, prompt=[text_block("Show me the atlas")])
        mid = len(h.client.notifications)
        second = await h.conn.prompt(session_id=ben, prompt=[text_block("Show me the atlas")])

    assert first.stop_reason == second.stop_reason == "end_turn"
    for session, sent in ((ana, h.client.notifications[:mid]), (ben, h.client.notifications[mid:])):
        assert sent == [
            ("canvas/focus", {"sessionId": session, "paperIds": ["pmid:1"]}),
            ("canvas/highlight", {"sessionId": session, "paperIds": ["pmid:1"], "shapeIds": ["shape:note-1"], "durationMs": 4000}),
            ("canvas/open_paper", {"sessionId": session, "paperId": "pmid:1"}),
            ("canvas/tour", {"sessionId": session, "title": "Since Friday", "steps": WIRE_STEPS}),
        ]
    # No cards for pointing; the canvas shows it.
    assert not [u for u in h.client.updates if u.session_update == "tool_call"]

    # On the wire: `_canvas/focus`, after the message chunk the model wrote before calling it.
    wire = h.stdout_messages()
    methods = [m.get("method") for m in wire]
    assert "_canvas/focus" in methods and "_canvas/tour" in methods
    chunk = next(
        i for i, m in enumerate(wire)
        if m.get("method") == "session/update" and m["params"]["update"]["sessionUpdate"] == "agent_message_chunk"
    )
    assert chunk < methods.index("_canvas/focus")
