"""The look tools and the images plugin (T07): the agent sees a picture in its next model call, once.

`look_at_board` asks the browser for `_canvas/snapshot`; `look_at_figure` takes
a figure's image URL from the papers MCP (D25). Tool results carry text only,
so `harness.acp.images.ImagesPlugin` adds the picture to the next request and
to no request after it. These run the real `SessionWorker` with a scripted model
that records each request; the last test goes over the ACP wire.
"""

import asyncio
import base64
import json
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from acp import RequestError, image_block, text_block
from google.adk.agents import LlmAgent
from google.adk.models.llm_request import LlmRequest
from google.genai import types

from conftest import ScriptedLlm, call, say
from fixtures.acp_client import harness
from harness.acp.images import OLD_PICTURE, ImagesPlugin
from harness.acp.mapping import NO_IMAGES
from harness.acp.worker import SessionWorker
from harness.board import viewer
from harness.board.tools import BoardTools
from harness.board.viewer import PendingImage
from harness.models import LIGHTNING, SUPER_VL

TESTS = Path(__file__).parent
CANVAS_PNG = TESTS.parents[1] / "docs" / "mockups" / "shots" / "canvas.png"
PNG = b"\x89PNG a small fake"
CAPTION = "Whole board, with 7 cards, 2 clusters"
HIDDEN = "The researcher's tab is in the background, so the board can't be drawn right now."
URL = "https://cdn.ncbi.nlm.nih.gov/pmc/blobs/c11f/4944528/48328c626293/nihms791837f3.jpg"
FIGURES = [
    {"figureId": "F1", "label": "Figure 1", "caption": "Overview of workflow.", "imageUrl": None},
    {"figureId": "F2", "label": "Figure 2", "caption": "Malignant cell states.", "imageUrl": URL.replace("f3", "f2")},
    {"figureId": "F3", "label": "Figure 3", "caption": "UMAP of T cells; (B) tissue section.", "imageUrl": URL},
]


def snapshot(data: bytes = PNG, caption: str = CAPTION) -> dict[str, Any]:
    """`_canvas/snapshot`'s result, as `client/shared/acpExt.ts` describes it."""
    return {"mimeType": "image/png", "data": base64.b64encode(data).decode(), "width": 1600, "height": 980, "caption": caption}


class Browser:
    """The ACP connection's browser end: answers `_canvas/snapshot` with `answer`, an error, or never."""

    def __init__(self, answer: Any = None) -> None:
        self.answer = answer
        self.asked: list[tuple[str, dict[str, Any]]] = []

    async def ext_method(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.asked.append((method, params))
        if isinstance(self.answer, Exception):
            raise self.answer
        if self.answer is None:
            await asyncio.Event().wait()  # a browser that never answers
        return self.answer

    async def ext_notification(self, method: str, params: dict[str, Any]) -> None:
        pass


async def chat(browser: Browser, turns: list[types.Content], prompts: list[list[Any]], model: str = SUPER_VL):
    """Run `prompts` through one session's worker; the scripted model and the session updates sent."""
    board = BoardTools("b_test", "m_ana", conn=browser, session_id="s_ana")
    llm = ScriptedLlm(turns=turns)
    agent = LlmAgent(name="board_assistant", model=llm, instruction="Help with the board.", tools=board.viewer())
    board.models[agent.name] = model
    sent: list[Any] = []

    async def send(update: Any) -> None:
        sent.append(update)

    worker = SessionWorker(send, agent, board)
    try:
        for prompt in prompts:
            assert await worker.prompt(prompt) == "end_turn"
    finally:
        await worker.close()
    assert not board.images, "every picture went to a model call"
    return llm, sent


def pictures(request: LlmRequest) -> list[types.Part]:
    return [p for c in request.contents for p in c.parts or [] if p.inline_data or p.file_data]


def with_pictures(request: LlmRequest) -> list[types.Content]:
    return [c for c in request.contents if any(p.inline_data or p.file_data for p in c.parts or [])]


def tool_result(request: LlmRequest, name: str) -> dict[str, Any]:
    """The latest result of tool `name` in the request."""
    return [
        p.function_response.response
        for c in request.contents for p in c.parts or []
        if p.function_response and p.function_response.name == name
    ][-1]


async def test_the_board_picture_goes_into_the_next_request_only():
    browser = Browser(snapshot())
    llm, sent = await chat(
        browser,
        [call("look_at_board", target="board"), say("Two clusters: tumour ecosystem and T-cell states."), say("Still two.")],
        [[text_block("How is the board organised?")], [text_block("And now?")]],
    )
    assert browser.asked == [("canvas/snapshot", {"sessionId": "s_ana", "target": "board"})]
    first, looked, later = llm.requests

    assert pictures(first) == []
    # exactly one user message, after the tool's result: the line saying what it is, then the PNG
    (message,) = with_pictures(looked)
    assert message is looked.contents[-1] and message.role == "user"
    caption, image = message.parts
    assert caption.text == f"Picture of the board: {CAPTION}"
    assert (image.inline_data.mime_type, image.inline_data.data) == ("image/png", PNG)
    assert tool_result(looked, "look_at_board") == {"ok": True, "image": f"{CAPTION}, 1600×980", "note": viewer.NEXT_STEP}
    # criterion 6: the next turn's request has the tool's text result but not the picture
    assert pictures(later) == []
    assert tool_result(later, "look_at_board")["ok"] is True

    # the look gets a tool card, unlike focus and highlight
    (card,) = [u for u in sent if u.session_update == "tool_call"]
    assert card.title == "board_assistant: look_at_board"
    (end,) = [u for u in sent if u.session_update == "tool_call_update"]
    assert end.status == "completed"


async def test_papers_are_asked_for_as_shapes_with_their_paper_ids():
    browser = Browser(snapshot(caption="Liu 2022, with 2 linked papers"))
    llm, _ = await chat(
        browser,
        [call("look_at_board", target="papers"), call("look_at_board", target="papers", paper_ids=["pmid:2"]), say("Linked.")],
        [[text_block("How do these connect?")]],
    )
    # without paper_ids nothing is asked
    assert browser.asked == [("canvas/snapshot", {"sessionId": "s_ana", "target": "shapes", "paperIds": ["pmid:2"]})]
    assert tool_result(llm.requests[1], "look_at_board")["ok"] is False
    assert [p.text for c in with_pictures(llm.requests[2]) for p in c.parts if p.text] == [
        "Picture of the board: Liu 2022, with 2 linked papers"
    ]


async def test_a_hidden_tab_is_reported_and_nothing_is_attached():
    browser = Browser(RequestError(-32000, HIDDEN))
    llm, sent = await chat(browser, [call("look_at_board", target="viewport"), say("I couldn't see the board.")], [[text_block("What am I looking at?")]])
    assert tool_result(llm.requests[1], "look_at_board") == {"ok": False, "error": f"Couldn't see the board: {HIDDEN}"}
    assert pictures(llm.requests[1]) == []
    (end,) = [u for u in sent if u.session_update == "tool_call_update"]
    assert end.status == "failed"


async def test_a_browser_that_never_answers_fails_at_the_timeout(monkeypatch):
    monkeypatch.setattr(viewer, "SNAPSHOT_SECONDS", 0.2)
    started = time.monotonic()
    llm, _ = await chat(Browser(None), [call("look_at_board", target="board"), say("I couldn't see it.")], [[text_block("Look")]])
    assert time.monotonic() - started < 5
    assert tool_result(llm.requests[1], "look_at_board") == {
        "ok": False,
        "error": "Couldn't see the board: no picture came within 0.2 seconds.",
    }


async def test_a_model_that_cannot_see_gets_the_line_and_a_note():
    llm, _ = await chat(Browser(snapshot()), [call("look_at_board", target="board"), say("…")], [[text_block("Look")]], model=LIGHTNING)
    last = llm.requests[1].contents[-1]
    assert [p.text for p in last.parts] == [f"Picture of the board: {CAPTION}", NO_IMAGES]
    assert pictures(llm.requests[1]) == []


async def test_an_earlier_prompts_picture_is_left_out_of_later_turns():
    view = [text_block("What am I looking at?"), text_block("Picture of the board: The researcher's current view"), image_block(base64.b64encode(PNG).decode(), "image/png")]
    newer = [text_block("And now?"), text_block("Picture of the board: The researcher's current view"), image_block(base64.b64encode(b"\x89PNG newer").decode(), "image/png")]
    llm, _ = await chat(Browser(), [say("Three cards."), say("Two cards."), say("Done.")], [view, newer, [text_block("Thanks")]])
    first, second, third = llm.requests
    assert [p.inline_data.data for p in pictures(first)] == [PNG]
    # the turn's own picture stays; the earlier one is a note now
    assert [p.inline_data.data for p in pictures(second)] == [b"\x89PNG newer"]
    assert OLD_PICTURE in [p.text for p in second.contents[0].parts]
    assert pictures(third) == []


async def test_a_picture_left_from_a_cancelled_turn_is_dropped():
    old = types.Part(inline_data=types.Blob(mime_type="image/png", data=PNG))
    pending = [PendingImage("board_assistant", "e-old", "Picture of the board: old", old)]
    prompt = types.Content(role="user", parts=[types.Part(text="Hello again")])
    request = LlmRequest(contents=[prompt])
    ctx = SimpleNamespace(agent_name="board_assistant", invocation_id="e-new", user_content=prompt)
    await ImagesPlugin(pending, {"board_assistant": SUPER_VL}).before_model_callback(callback_context=ctx, llm_request=request)
    assert request.contents == [prompt] and pending == []


@pytest.fixture
def get_figures(papers_mcp):
    @papers_mcp.server.tool()
    async def get_figures(paper_id: str) -> dict[str, Any]:
        papers_mcp.calls.append(("get_figures", {"paper_id": paper_id}))
        figures = FIGURES if paper_id == "pmid:1" else [FIGURES[0]]
        return {"paperId": paper_id, "source": "pmc", "figures": figures, "skipped": []}


async def test_look_at_figure_attaches_the_figure_by_its_url(papers_mcp, get_figures):
    llm, sent = await chat(
        Browser(),
        [call("look_at_figure", paper_id="pmid:1", label="Fig. 3"), say("A UMAP and a tissue section."), say("Bye.")],
        [[text_block("What does this figure show?")], [text_block("Thanks")]],
    )
    assert ("get_figures", {"paper_id": "pmid:1"}) in papers_mcp.calls
    (message,) = with_pictures(llm.requests[1])
    line, image = message.parts
    assert line.text == 'Picture of Figure 3 of pmid:1, captioned: "UMAP of T cells; (B) tissue section."'
    assert (image.file_data.file_uri, image.file_data.mime_type) == (URL, "image/jpeg")
    assert tool_result(llm.requests[1], "look_at_figure") == {"ok": True, "image": "Figure 3 of pmid:1", "note": viewer.NEXT_STEP}
    assert pictures(llm.requests[2]) == []
    assert [u.title for u in sent if u.session_update == "tool_call"] == ["board_assistant: look_at_figure"]


async def test_look_at_figure_without_a_figure_says_so(papers_mcp, get_figures):
    llm, _ = await chat(
        Browser(),
        [call("look_at_figure", paper_id="pmid:9"), call("look_at_figure", paper_id="pmid:1", label="Figure 1"), say("…")],
        [[text_block("What does the figure show?")]],
    )
    assert tool_result(llm.requests[1], "look_at_figure") == {"ok": False, "error": "This paper has no figure on the board."}
    # Figure 1 has no picture, so the first one that does is shown, and the result says so
    result = tool_result(llm.requests[2], "look_at_figure")
    assert result["image"] == "Figure 2 of pmid:1" and result["note"].startswith("Figure 1 has no picture")


def test_pick_figure_matches_labels_loosely():
    assert viewer.pick_figure(FIGURES, "fig 3") is FIGURES[2]
    assert viewer.pick_figure(FIGURES, "F3") is FIGURES[2]
    assert viewer.pick_figure(FIGURES) is FIGURES[1]
    assert viewer.pick_figure([FIGURES[0]]) is None
    assert viewer.pick_figure(None) is None


async def test_over_acp_the_browser_gets_the_request_and_the_chat_a_card(tmp_path):
    script = {"board_assistant": [call_turn("look_at_board", target="viewport"), {"text": "Two clusters."}]}
    path = tmp_path / "script.json"
    path.write_text(json.dumps(script))
    env = {"HARNESS_MODEL": f"scripted:{path}", "HARNESS_AGENT": "board_assistant", "TF_API_KEY": "", "PYTHONPATH": str(TESTS)}
    async with harness(env=env) as h:
        h.client.answers["canvas/snapshot"] = snapshot(CANVAS_PNG.read_bytes(), "The researcher's current view, with 7 cards")
        session = await h.start()
        response = await h.conn.prompt(session_id=session, prompt=[text_block("What am I looking at?")])

    assert response.stop_reason == "end_turn"
    assert h.client.requests == [("canvas/snapshot", {"sessionId": session, "target": "viewport"})]
    assert "_canvas/snapshot" in [m.get("method") for m in h.stdout_messages()]
    (card,) = h.client.cards()
    assert card.title == "board_assistant: look_at_board"
    end = next(u for u in h.client.updates if u.session_update == "tool_call_update")
    assert end.status == "completed"
    assert end.raw_output["image"] == "The researcher's current view, with 7 cards, 1600×980"


def call_turn(name: str, **args: Any) -> dict[str, Any]:
    return {"calls": [{"name": name, "args": args}]}
