"""Viewer tools: point at things on one researcher's screen (T06, decision D3).

Each tool sends an ACP extension notification to the browser of the chat it
belongs to, so that researcher's camera moves or their cards light up while
nobody else's view changes and nothing is written to the board.
`conn.ext_notification("canvas/focus", …)` puts `_canvas/focus` on the wire;
the params are the group README's (Shared contracts) and `client/shared/acpExt.ts`.
Their names are `VIEWER_TOOLS`, so the trace plugin gives them no card.
"""

from __future__ import annotations

import logging
from typing import Any

from google.adk.tools import BaseTool, FunctionTool
from pydantic import BaseModel

log = logging.getLogger(__name__)


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
            return {"ok": False, "error": "The researcher's browser is no longer connected."}
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
