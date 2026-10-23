"""Viewer tools: point at things on one researcher's screen (T06, decision D3), and look at them (T07).

Each pointing tool sends an ACP extension notification to the browser of the
chat it belongs to, so that researcher's camera moves or their cards light up
while nobody else's view changes and nothing is written to the board.
`conn.ext_notification("canvas/focus", …)` puts `_canvas/focus` on the wire;
the params are the group README's (Shared contracts) and `client/shared/acpExt.ts`.
Their names are `VIEWER_TOOLS`, so the trace plugin gives them no card.

The look tools do get cards. `look_at_board` asks the same browser for a PNG
(`_canvas/snapshot`, a request), `look_at_figure` takes a figure's image URL
from the papers MCP (decision D25). Token Factory's tool results carry text
only, so both queue the picture on `BoardTools.images` and return a short
text; `harness.acp.images.ImagesPlugin` puts it in the agent's next model call.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import mimetypes
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal
from urllib.parse import urlsplit

from acp import RequestError
from google.adk.tools import BaseTool, FunctionTool, ToolContext
from google.genai import types
from pydantic import BaseModel

from harness.agents.args import PLACEHOLDERS
from harness.toolsets import error_text, failed, structured

if TYPE_CHECKING:
    from harness.board.tools import BoardTools

log = logging.getLogger(__name__)

GONE = "The researcher's browser is no longer connected."
# The browser gives up after 10 seconds too (a hidden tab answers at once).
SNAPSHOT_SECONDS = 10.0
# look_at_board's targets as `_canvas/snapshot` names them.
SNAPSHOT_TARGETS = {"viewport": "viewport", "board": "board", "papers": "shapes"}
NO_FIGURE = "This paper has no figure on the board."
NEXT_STEP = "The picture comes with your next step."
CAPTION_CHARS = 600


@dataclass(frozen=True)
class PendingImage:
    """A picture a look tool took, for the next model call of the agent that asked, in the same run."""

    agent: str
    invocation: str
    caption: str  # the line before the picture, saying what it shows
    part: types.Part

    @classmethod
    def taken(cls, ctx: ToolContext, caption: str, part: types.Part) -> PendingImage:
        return cls(ctx.agent_name, ctx.invocation_id, caption, part)


class TourStep(BaseModel):
    paper_id: str
    line: str


def viewer_tools(conn: Any, session_id: str) -> list[BaseTool]:
    """`focus`, `highlight`, `open_paper` and `tour`, bound to one ACP session."""

    async def notify(method: str, params: dict[str, Any]) -> dict[str, Any]:
        try:
            await conn.ext_notification(method, {"sessionId": session_id, **params})
        except ConnectionError:
            log.debug("client gone, dropped %s", method)
            return {"ok": False, "error": GONE}
        return {"ok": True}

    def targets(paper_ids: list[str] | None, shape_ids: list[str] | None) -> dict[str, list[str]]:
        found: dict[str, list[str]] = {}
        if paper_ids:
            found["paperIds"] = list(paper_ids)
        if shape_ids:
            found["shapeIds"] = list(shape_ids)
        return found

    async def focus(paper_ids: list[str] | None = None, shape_ids: list[str] | None = None) -> dict[str, Any]:
        """Zoom the researcher's view to these papers or shapes. Use it when walking them
        through papers or when they ask to see one. Only their screen changes, never the board.

        Args:
            paper_ids: Paper IDs as the tools return them, like "pmid:34290406".
            shape_ids: Shape IDs from the board or the selection, for shapes that aren't papers.
        """
        if not (found := targets(paper_ids, shape_ids)):
            return {"ok": False, "error": "Give paper_ids or shape_ids."}
        return await notify("canvas/focus", found)

    async def highlight(
        paper_ids: list[str] | None = None, shape_ids: list[str] | None = None, seconds: int = 6
    ) -> dict[str, Any]:
        """Make these cards stand out on the researcher's screen for a few seconds, for
        "the cards behind this answer". Only their screen changes, never the board.

        Args:
            paper_ids: Paper IDs as the tools return them.
            shape_ids: Shape IDs from the board or the selection.
            seconds: How long the cards stay marked.
        """
        if not (found := targets(paper_ids, shape_ids)):
            return {"ok": False, "error": "Give paper_ids or shape_ids."}
        return await notify("canvas/highlight", {**found, "durationMs": max(seconds, 1) * 1000})

    async def open_paper(paper_id: str) -> dict[str, Any]:
        """Open one paper's card on the researcher's screen, when they ask to see or read it.

        Args:
            paper_id: The paper ID as the tools return it.
        """
        return await notify("canvas/open_paper", {"paperId": paper_id})

    async def tour(steps: list[TourStep], title: str = "Catch-up") -> dict[str, Any]:
        """Walk the researcher through papers inside the paper card, one step per paper, the
        strongest first; Keep or Discard moves them on. Send the whole tour once.

        Args:
            steps: One step per paper, in order: its paper_id and one line on why it matters to them.
            title: The tour's heading.
        """
        wire = [{"paperId": s.paper_id, "line": s.line} for s in map(TourStep.model_validate, steps)]
        if not wire:
            return {"ok": False, "error": "Give at least one step."}
        return await notify("canvas/tour", {"title": title, "steps": wire})

    return [FunctionTool(tool) for tool in (focus, highlight, open_paper, tour)]


def look_tools(board: BoardTools) -> list[BaseTool]:
    """`look_at_board` and `look_at_figure` for one ACP session; pictures go on `board.images`."""

    async def look_at_board(
        target: Literal["viewport", "board", "papers"], tool_context: ToolContext, paper_ids: list[str] | None = None
    ) -> dict[str, Any]:
        """See the board as a picture, the way the researcher does. Look for questions about the
        layout, the clusters, the links or what they are looking at ("what am I looking at?",
        "how is the board organised?"). The picture comes with your next step.

        Args:
            target: "viewport" for the researcher's current view, "board" for the whole board,
                "papers" for the cards of `paper_ids` and the papers linked to them.
            paper_ids: For "papers": the paper IDs to look at.
        """
        params: dict[str, Any] = {"sessionId": board.session_id, "target": SNAPSHOT_TARGETS.get(target)}
        if params["target"] is None:
            return {"ok": False, "error": 'target is "viewport", "board" or "papers".'}
        if target == "papers":
            # a model may send one ID as a string, or "None" for none
            ids = [paper_ids] if isinstance(paper_ids, str) else list(paper_ids or [])
            if not (ids := [i for i in ids if i and i not in PLACEHOLDERS]):
                return {"ok": False, "error": 'Give paper_ids to look at with target "papers".'}
            params["paperIds"] = ids
        try:
            async with asyncio.timeout(SNAPSHOT_SECONDS):
                shot = await board.conn.ext_method("canvas/snapshot", params)
        except TimeoutError:
            return {"ok": False, "error": f"Couldn't see the board: no picture came within {SNAPSHOT_SECONDS:g} seconds."}
        except RequestError as error:
            return {"ok": False, "error": f"Couldn't see the board: {error}"}
        except ConnectionError:
            return {"ok": False, "error": GONE}
        try:
            data = base64.b64decode(shot["data"], validate=True)
            size = f"{int(shot['width'])}×{int(shot['height'])}"
            caption = str(shot.get("caption") or "The board")
        except (KeyError, TypeError, ValueError, binascii.Error):
            log.warning("unusable snapshot from the browser: %.200s", shot)
            return {"ok": False, "error": "Couldn't see the board: the browser sent no picture."}
        image = types.Part(inline_data=types.Blob(mime_type="image/png", data=data))
        board.images.append(PendingImage.taken(tool_context, f"Picture of the board: {caption}", image))
        return {"ok": True, "image": f"{caption}, {size}", "note": NEXT_STEP}

    async def look_at_figure(paper_id: str, tool_context: ToolContext, label: str = "") -> dict[str, Any]:
        """See one of a paper's figures as a picture: its chart, image or drawing. Look when a
        question is about what a figure shows, not just its caption. The picture comes with
        your next step.

        Args:
            paper_id: The paper ID as the tools return it.
            label: Which figure, like "Figure 2"; a card's `figure` in the selection names the
                one it shows. Leave empty for the paper's first figure with a picture.
        """
        toolset = board.papers("get_figures")
        try:
            tools = {tool.name: tool for tool in await toolset.get_tools(tool_context)}
            if "get_figures" not in tools:
                return {"ok": False, "error": "The papers service has no figures to show."}
            result = await tools["get_figures"].run_async(args={"paper_id": paper_id}, tool_context=tool_context)
        except Exception as error:
            log.warning("get_figures for %s failed: %s", paper_id, error)
            return {"ok": False, "error": f"Couldn't fetch the figures: {error}"}
        finally:
            await toolset.close()
        if failed(result):
            return {"ok": False, "error": f"Couldn't fetch the figures: {error_text(result)}"}
        figure = pick_figure(structured(result).get("figures"), label)
        if figure is None:
            return {"ok": False, "error": NO_FIGURE}
        url = figure["imageUrl"]
        name = str(figure.get("label") or "Figure")
        mime = mimetypes.guess_type(urlsplit(url).path)[0] or ""
        mime = mime if mime.startswith("image/") else "image/jpeg"  # LiteLLM sends image/* URLs as image_url
        caption = " ".join(str(figure.get("caption") or "").split())[:CAPTION_CHARS]
        line = f"Picture of {name} of {paper_id}" + (f', captioned: "{caption}"' if caption else "")
        image = types.Part(file_data=types.FileData(file_uri=url, mime_type=mime))
        board.images.append(PendingImage.taken(tool_context, line, image))
        found: dict[str, Any] = {"ok": True, "image": f"{name} of {paper_id}", "note": NEXT_STEP}
        if (wanted := figure_key(label)) is not None and figure_key(name) != wanted:
            found["note"] = f"{label} has no picture, so this is {name}. {NEXT_STEP}"
        return found

    return [FunctionTool(look_at_board), FunctionTool(look_at_figure)]


def figure_key(label: Any) -> tuple[str, int] | None:
    """A figure label's series and number, panel letters ignored: "Figure 2B" is ("main", 2),
    "Extended Data Fig. 3" is ("extended", 3), "Figure 1—figure supplement 2" and "Fig. S3" are
    ("supplement", 2) and ("supplement", 3). None when the label has no number."""
    lower = str(label or "").lower()
    if (first := re.search(r"\d+", lower)) is None:
        return None
    after = lower.find("supplement")
    number = (after >= 0 and re.search(r"\d+", lower[after:])) or first
    if "extended" in lower:
        series = "extended"
    elif after >= 0 or lower[first.start() - 1 : first.start()] == "s":
        series = "supplement"
    else:
        series = "main"
    return series, int(number.group(0))


def pick_figure(figures: Any, label: str = "") -> dict[str, Any] | None:
    """The figure called `label` with a picture, else the first figure with one."""
    shown = [
        f for f in figures or []
        if isinstance(f, dict) and isinstance(f.get("imageUrl"), str) and f["imageUrl"].startswith(("https://", "http://"))
    ]
    if (wanted := figure_key(label)) is not None:
        named = next((f for f in shown if figure_key(f.get("label")) == wanted or f.get("figureId") == label), None)
        if named:
            return named
    return shown[0] if shown else None
