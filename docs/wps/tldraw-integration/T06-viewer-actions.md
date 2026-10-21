# T06: Per-viewer canvas actions: focus, highlight, open paper, catch-up tour

| Field | Value |
| --- | --- |
| Lane | Harness (board half) + Browser |
| Size | S |
| Depends on | T04, T05 |
| Unblocks | T09 (row click reuses focus), T12, the catch-me-up tour (harness owner) |
| Milestone | M3; the Oct 20 refresh (the tour) is W2 One clean run |
| Priority | P1 (refresh) |
| Status | Harness half done: the four tools send `_canvas/*`. Browser: `focus`, `highlight` and `open_paper` are handled; `_canvas/tour` arrives but only logs (no tour yet). Refresh (Oct 20) not started: see What's left |
| Owner | TBD |

## Where it stands (Oct 20)

| Part | State | Where |
| --- | --- | --- |
| `focus`, `highlight`, `open_paper`, `tour` harness tools | Built and tested | `harness/harness/board/viewer.py`, `harness/tests/test_viewer_tools.py` |
| Browser `focus`, `highlight`, `open_paper` | Built (files under `chat/`, not `canvas/` as planned) | `client/client/chat/viewerActions.ts`, `viewerBus.ts` |
| `_canvas/tour` | Logged only: "the tour is not built yet" (F14) | `client/client/chat/viewerActions.ts` |
| "Catch me up (N)" | Built in the top bar, but it only cycles `openPaperId` through the new papers: no tour bar, no agent line, no Prev/Next/Done/× (F14) | `client/client/pinboard/TopBar.tsx`, `CatchMeUp` |
| Keep / Discard during Catch me up | Keep stays on the same paper; Discard closes the widgets (F15) | `client/client/widgets/parts.tsx`, `ActionsWidget` |
| `?tour=1` from Home | Ignored | `client/client/pages/Room.tsx` |
| Busy-user queue, "Follow the agent" | Not built | — |

## What's left (v6)

The spec is the v6 demo board (`client/public/landing/demo-board.html`, "Catch me up") and [`shots-v6/15-catchup.png`](../../mockups/shots-v6/15-catchup.png).

**Decision D24: Catch me up is a local tour.** The top bar's button starts the tour in the browser from the board's own data, with no prompt to the agent; the agent can still start one with `_canvas/tour`. This replaces T13's "sends the prompt Catch me up": the button works with the chat closed, costs nothing, and the agent's lines already exist on the cards.

**Tour state** (`client/client/viewerState.ts`): `tour = atom<{ title: string; steps: { paperId: string; line: string }[]; i: number } | null>('tour', null)`. A pure reducer in `client/client/widgets/tour.ts`:

| Action | Effect |
| --- | --- |
| `start(steps, title)` | `i = 0`; opens the first paper (`openPaperId`), its widgets grow out of its node (T10) |
| `next` / `prev` | Moves `i`, opens that paper |
| `voted(paperId, decision)` | Keep: next step. Discard: the paper leaves the steps, the next one opens. After the last step: `end` |
| `end` (Done, ×, Escape, last step voted) | `tour = null`, widgets close, the camera flies back to where it was; [T16](T16-start-and-home-pages.md) posts `/seen` |

**Where steps come from:**

| Source | Steps |
| --- | --- |
| "Catch me up (N)" (`TopBar.tsx`) | `boardDerived(editor).fresh` (new, not discarded, in the viewer's ranking order); each line is the card's `scores[currentGoal].why`, else its `oneLine`, else "New since your last visit" |
| `?tour=1` (`Room.tsx`) | The same, once the room has synced and has at least one fresh paper; the parameter is removed from the URL |
| `_canvas/tour` (`viewerActions.ts`) | The agent's `steps` and `title`, papers not on the board dropped |

**The tour bar** sits in the actions widget under the node (T10's `ActionsWidget`): "CATCH-UP · i OF n", one dot per step, the line, ‹ Prev, Next › (Done on the last step) and ×; Keep and Discard stay beside it and move on.

**Deferred** (not in the demo script): the busy-user queue and "Follow the agent" (acceptance criteria 4 and 5 above stay open).

**Tasks:**

- [ ] `client/client/viewerState.ts`: `tour`; `client/client/widgets/tour.ts`: the reducer and `stepsFromBoard(derived, goal)`.
- [ ] `client/client/pinboard/TopBar.tsx`: `CatchMeUp` starts the tour.
- [ ] `client/client/pages/Room.tsx`: `?tour=1`.
- [ ] `client/client/chat/viewerActions.ts`: `_canvas/tour` starts the tour.
- [ ] `client/client/widgets/parts.tsx`: the tour bar in `ActionsWidget`; Keep and Discard call `voted` (through the T10 refresh's `onVoted`).
- [ ] `client/client/widgets/tour.test.ts`.

**Acceptance criteria (refresh, replacing 6 above for v6):**

1. On a board with three new papers, "Catch me up 3" opens the first in the viewer's ranking order with "CATCH-UP · 1 OF 3" and its why line under the node; Next and Prev move between them; × ends the tour and the camera returns.
2. Keep records the vote for everyone and opens paper 2; Discard on paper 2 opens paper 3; voting on the last paper ends the tour (demo-script steps 4 and 5).
3. Opening `/<board>?tour=1` starts the same tour once the board has loaded.
4. An agent's `_canvas/tour` with two steps runs the same tour with the agent's lines; a teammate's view never moves.

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
