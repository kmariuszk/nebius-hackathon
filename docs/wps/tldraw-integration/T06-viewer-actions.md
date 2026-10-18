# T06: Per-viewer canvas actions: focus, highlight, open paper, catch-up tour

| Field | Value |
| --- | --- |
| Lane | Harness (board half) + Browser |
| Size | S |
| Depends on | T04, T05 |
| Unblocks | T09 (row click reuses focus), T12, the catch-me-up tour (harness owner) |
| Milestone | M3 |
| Status | Harness half done: the four tools send `_canvas/*`. Browser: `focus`, `highlight` and `open_paper` are handled; `_canvas/tour` arrives but only logs (no tour yet) |
| Owner | TBD |

## Goal

The agent can point at things for the person it is talking to: zoom their view to papers, light papers up on their screen, open a paper's widgets for them, walk them through new papers. Nobody else's view changes, and nothing is written to the shared board.

## Context

- [Architecture diagram 3 (Catch me up)](../../architecture.html#catchup): `_canvas/focus` zooms in on each new paper "(Ana's view only)" while teammates keep theirs.
- [Concept: Design choices](../../Concept.md#system-architecture): "Shared changes through MCP, per-viewer actions through ACP"; [ACP event table](../../Concept.md#acp-one-researchers-conversation), last row.
- Contracts: the `_canvas/*` table in the [group README](README.md#shared-contracts).
- In tldraw 5.5, the camera and `instance_page_state` (which holds `hintingShapeIds`) have scope `session`: they are never synced to other people. Selection is too, but collaborators see each other's selection through presence, so we don't use selection for this.
- Per-viewer atoms in `client/client/viewerState.ts` (in place): `openPaperId` (the paper whose widgets are open, T10) and `litPaperIds` (papers lit up on this screen; T01 draws them).

## Scope

**In:** four harness tools that send the notifications; the browser handlers; local focus from chat paper links and tool cards; a "Follow the agent" switch; not interrupting someone mid-drag.

**Out:** the catch-me-up reasoning itself (harness owner: the master reads the activity since the researcher's last visit and calls `tour` with an ordered list and one line per paper); the "Catch me up (N)" button (T13, sends the prompt); the widgets' content (T10).

**v4 and v5 change.** The [v4 mockup](../../mockups/README.md) put the tour inside the card; v5 puts it in the actions widget under each paper's node ("During Catch me up, the agent's line and Next/Prev sit here too"), and each paper's widgets grow out of its node. Keep or Discard moves on to the next paper. This replaces a chat-driven sequence of `focus` calls: the `tour` tool and `_canvas/tour` notification implement it, and `focus` stays for pointing during normal chat.

## Design

**Harness side** (`harness/harness/board/viewer.py`, returned by `BoardTools.viewer()`): four ADK function tools bound to one ACP session (a closure over `conn` and `session_id`):

| Tool | Signature | Sends |
| --- | --- | --- |
| `focus` | `focus(paper_ids: list[str] \| None = None, shape_ids: list[str] \| None = None)` | `conn.ext_notification("canvas/focus", {sessionId, paperIds, shapeIds})`, on the wire `_canvas/focus` |
| `highlight` | `highlight(paper_ids: list[str] \| None = None, shape_ids: list[str] \| None = None, seconds: int = 6)` | `_canvas/highlight` with `durationMs` |
| `open_paper` | `open_paper(paper_id: str)` | `_canvas/open_paper` |
| `tour` | `tour(steps: list[{paper_id, line}], title: str = "Catch-up")` | `_canvas/tour` with `{sessionId, title, steps: [{paperId, line}]}` |

- Each returns `{"ok": true}` at once; the browser doesn't answer (notifications, not requests). With nothing to point at (no IDs, no tour steps) or the browser gone, it sends nothing and returns `{"ok": false, "error": …}` for the model. Empty ID lists are left out of the params.
- Docstrings tell the model when to use them: focus when pointing someone at papers, highlight for "the papers behind this answer", open_paper when asked to show a paper, tour to walk through new papers. They change only the asker's screen and never the board.
- Notifications and `session/update` messages travel the same ordered stdout, so a tour that alternates text and `focus` arrives in that order.
- No tool cards for these (T04's plugin skips them); their effect is visible on the canvas.
- [T07](T07-board-context.md) adds two more tools to the same list that *look* rather than point (`look_at_board`, `look_at_paper`); they use the `_canvas/snapshot` request and do get tool cards, so the researcher sees when the agent looked.

**Browser side** (`client/client/canvas/viewerActions.ts`, subscribed to `viewerBus` from T05):

| Action | Behaviour |
| --- | --- |
| Resolve targets | `paperIds` become `paperShapeId(id)` (shared helper, T01); keep only shapes on the current page; if none remain, show a toast "That paper isn't on the board yet" |
| `focus` | `editor.zoomToBounds(Box.Common(bounds), { inset: params.inset ?? 96, animation: { duration: 450 } })`; no animation if the user prefers reduced motion; for one small node, cap the zoom at 1 so it doesn't fill the screen |
| `highlight` | Papers go into `litPaperIds`, which T01's node draws as lit; other shapes get `editor.setHintingShapes(ids)`. Both clear after `durationMs` (default 6 s) or on the next highlight; if hinting turns out too subtle for the other shapes, draw a pulsing outline per shape in `components.InFrontOfTheCanvas`, positioned with `editor.pageToViewport` |
| `open_paper` | Call T10's `openPaper(paperId)` (sets `openPaperId`, zooms and fades); until T10, focus the node and show a toast |
| `tour` | The v5 catch-up: open the first paper's widgets, which grow out of its node, with the tour header in the actions widget under the node ("CATCH-UP · 1 OF 3", step dots, the agent's line, Prev, Next, ×). Keep or Discard votes (T10's `votes.ts`) and moves on; the last step closes the tour and zooms back out. The whole tour runs locally from one notification, so stepping through costs no model calls |
| Busy user | If the user is dragging, resizing or editing text (the select tool isn't in `select.idle`, checked with `editor.isIn`), queue the action and run it when they're idle; drop queued focuses older than 5 s |
| Follow the agent | A switch in the chat panel header (on by default). Off: `focus` becomes a "Show" chip in the chat instead of moving the camera; `highlight` still works |

Local sources reuse the same handlers: paper links in chat messages, the "Show on board" button on tool cards (T05) and ranked list rows (T09).

## Tasks

- [x] `harness/harness/board/viewer.py`; `BoardTools.viewer()` returns the four tools.
- [ ] Echo mode sends `_canvas/focus` for selected shapes.
- [ ] `client/client/canvas/tour.ts`: tour state (steps, index), driving T10's widgets and the tour header in the actions widget; the `_canvas/tour` schema in `client/shared/acpExt.ts`.
- [x] `harness/tests/test_viewer_tools.py`: scripted model calls `focus`; the test client receives `_canvas/focus` with the right `sessionId` and IDs, after the preceding message chunk.
- [ ] `client/client/canvas/viewerActions.ts` with `resolveTargets` and the busy queue as pure, tested functions.
- [ ] Hinting visibility check; the `InFrontOfTheCanvas` fallback only if needed.
- [ ] "Follow the agent" switch in `ChatPanel.tsx`.

## Acceptance criteria

1. Two browsers on one board; Ana asks "show me the paper on CD8 T cells". Ana's camera moves to the paper; Ben's camera, selection and screen don't change.
2. "Which papers back that up?" lights those papers up on Ana's screen for about 6 seconds, and on nobody else's; the room's records are unchanged (no new or updated documents in the sync log).
3. Clicking a paper link in the chat focuses the paper, with no harness involved.
4. With "Follow the agent" off, the agent's focus shows as a "Show" chip, and clicking it focuses.
5. A focus that arrives while Ana is dragging a paper waits until she lets go.
6. "Catch me up" on a board with three new papers opens the first paper's widgets with "CATCH-UP · 1 OF 3" and the agent's line under the node; Keep moves to paper 2 and records the vote for everyone; × ends the tour; Ben's view never moves.

## Tests

- Harness: `test_viewer_tools.py` (above).
- Browser: `client/client/canvas/viewerActions.test.ts` for target resolution (missing shapes, mixed IDs, other pages) and the busy queue.
- Manual: the two-browser checks in criteria 1 and 2, recorded for T12.

## Risks

- **Hinting is subtle**: it was made for binding targets, not for drawing attention. Papers don't depend on it (they use `litPaperIds`); check it for notes and links first; the overlay fallback is small.
- **Too much camera movement** annoys people: the reduced-motion rule, the busy queue and the switch keep the person in control.

## References

- [ACP extensibility](https://agentclientprotocol.com/protocol/extensibility)
- [tldraw camera and editor API](https://tldraw.dev/docs/editor)
