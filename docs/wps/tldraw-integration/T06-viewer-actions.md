# T06: Per-viewer canvas actions: focus, highlight, open paper

| Field | Value |
| --- | --- |
| Lane | Harness (board half) + Browser |
| Size | S |
| Depends on | T04, T05 |
| Unblocks | T09 (row click reuses focus), T12, the catch-me-up tour (harness owner) |
| Milestone | M3 |
| Status | Not started |
| Owner | TBD |

## Goal

The agent can point at things for the person it is talking to: zoom their view to cards, make cards stand out on their screen, open a paper for them. Nobody else's view changes, and nothing is written to the shared board.

## Context

- [Architecture diagram 3 (Catch me up)](../../architecture.html#catchup): `_canvas/focus` zooms in on each new paper "(Ana's view only)" while teammates keep theirs.
- [Concept: Design choices](../../Concept.md#system-architecture): "Shared changes through MCP, per-viewer actions through ACP"; [ACP event table](../../Concept.md#acp-one-researchers-conversation), last row.
- Contracts: the `_canvas/*` table in the [group README](README.md#shared-contracts).
- In tldraw 5.5, the camera and `instance_page_state` (which holds `hintingShapeIds`) have scope `session`: they are never synced to other people. Selection is too, but collaborators see each other's selection through presence, so we don't use selection for this.

## Scope

**In:** three harness tools that send the notifications; the browser handlers; local focus from chat paper links and tool cards; a "Follow the agent" switch; not interrupting someone mid-drag.

**Out:** the catch-me-up prompt itself (harness owner; it just calls these tools between message chunks); the paper overlay's content (T10; until it lands, `open_paper` focuses the card and shows a toast).

## Design

**Harness side** (`harness/harness/board/viewer.py`, returned by `BoardTools.viewer()`): three ADK function tools bound to one ACP session (a closure over `conn` and `session_id`):

| Tool | Signature | Sends |
| --- | --- | --- |
| `focus` | `focus(paper_ids: list[str] = [], shape_ids: list[str] = [])` | `conn.ext_notification("canvas/focus", {sessionId, paperIds, shapeIds})`, on the wire `_canvas/focus` |
| `highlight` | `highlight(paper_ids: list[str] = [], shape_ids: list[str] = [], seconds: int = 6)` | `_canvas/highlight` with `durationMs` |
| `open_paper` | `open_paper(paper_id: str)` | `_canvas/open_paper` |

- Each returns `{"ok": true}` at once; the browser doesn't answer (notifications, not requests).
- Docstrings tell the model when to use them: focus when walking someone through papers, highlight for "the cards behind this answer", open_paper when asked to show a paper. They change only the asker's screen and never the board.
- Notifications and `session/update` messages travel the same ordered stdout, so a tour that alternates text and `focus` arrives in that order.
- No tool cards for these (T04's plugin skips them); their effect is visible on the canvas.
- [T07](T07-board-context.md) adds two more tools to the same list that *look* rather than point (`look_at_board`, `look_at_paper`); they use the `_canvas/snapshot` request and do get tool cards, so the researcher sees when the agent looked.

**Browser side** (`client/client/canvas/viewerActions.ts`, subscribed to `viewerBus` from T05):

| Action | Behaviour |
| --- | --- |
| Resolve targets | `paperIds` become `paperShapeId(id)` (shared helper, T01); keep only shapes on the current page; if none remain, show a toast "That paper isn't on the board yet" |
| `focus` | `editor.zoomToBounds(Box.Common(bounds), { inset: params.inset ?? 96, animation: { duration: 450 } })`; no animation if the user prefers reduced motion; for one small card, cap the zoom at 1 so it doesn't fill the screen |
| `highlight` | `editor.setHintingShapes(ids)` and clear after `durationMs` (default 6 s) or on the next highlight; if hinting turns out too subtle, draw a pulsing outline per shape in `components.InFrontOfTheCanvas`, positioned with `editor.pageToViewport` |
| `open_paper` | Focus the card, then call T10's `openPaper(paperId)`; until T10, a toast "Paper view coming soon" |
| Busy user | If the user is dragging, resizing or editing text (the select tool isn't in `select.idle`, checked with `editor.isIn`), queue the action and run it when they're idle; drop queued focuses older than 5 s |
| Follow the agent | A switch in the chat panel header (on by default). Off: `focus` becomes a "Show" chip in the chat instead of moving the camera; `highlight` still works |

Local sources reuse the same handlers: paper links in chat messages, the "Show on board" button on tool cards (T05) and ranked list rows (T09).

## Tasks

- [ ] `harness/harness/board/viewer.py`; `BoardTools.viewer()` returns the three tools; echo mode sends `_canvas/focus` for selected shapes.
- [ ] `harness/tests/test_viewer_tools.py`: scripted model calls `focus`; the test client receives `_canvas/focus` with the right `sessionId` and IDs, after the preceding message chunk.
- [ ] `client/client/canvas/viewerActions.ts` with `resolveTargets` and the busy queue as pure, tested functions.
- [ ] Hinting visibility check; the `InFrontOfTheCanvas` fallback only if needed.
- [ ] "Follow the agent" switch in `ChatPanel.tsx`.

## Acceptance criteria

1. Two browsers on one board; Ana asks "show me the paper on CD8 T cells". Ana's camera moves to the card; Ben's camera, selection and screen don't change.
2. "Which cards back that up?" makes the cards stand out on Ana's screen for about 6 seconds, and on nobody else's; the room's records are unchanged (no new or updated documents in the sync log).
3. Clicking a paper link in the chat focuses the card, with no harness involved.
4. With "Follow the agent" off, the agent's focus shows as a "Show" chip, and clicking it focuses.
5. A focus that arrives while Ana is dragging a card waits until she lets go.

## Tests

- Harness: `test_viewer_tools.py` (above).
- Browser: `client/client/canvas/viewerActions.test.ts` for target resolution (missing shapes, mixed IDs, other pages) and the busy queue.
- Manual: the two-browser checks in criteria 1 and 2, recorded for T12.

## Risks

- **Hinting is subtle**: it was made for binding targets, not for drawing attention. Check it first; the overlay fallback is small.
- **Too much camera movement** annoys people: the reduced-motion rule, the busy queue and the switch keep the person in control.

## References

- [ACP extensibility](https://agentclientprotocol.com/protocol/extensibility)
- [tldraw camera and editor API](https://tldraw.dev/docs/editor)
