# T13: Board chrome (v4): top bar, bottom bar, help

| Field | Value |
| --- | --- |
| Lane | Browser |
| Size | M |
| Depends on | T01, T05 (chat), T08 (board, counts, agent presence) |
| Unblocks | T09 (the "Looking for" control), T12 |
| Milestone | M4; the Oct 20 refresh is W3 The team edits |
| Priority | P1 (refresh) |
| Status | Refresh built on branch `w3/editing` (Oct 21); a browser look is still to do: the title and the agent's avatar coming and going with a harness (criteria 1 and 2), the counter, list and "See what it did" (3 and 4), and the key beside a real board (5) |
| Owner | TBD |

## Where it stands (Oct 20)

| Part | State | Where |
| --- | --- | --- |
| tldraw's own UI hidden | Built | `client/client/pages/Room.tsx` (`components`) |
| Top bar: ‹ Boards, logo, board, Looking for, Pinboard switch, avatars, Catch me up, Chat | Built (files under `pinboard/`, not `chrome/` as planned); the board's name shows the room ID (`b_…`), not its title or question (F23) | `client/client/pinboard/TopBar.tsx` |
| The agent in the face pile | Always shown, whether a harness is running or not | `TopBar.tsx` (`Avatars`) |
| Catch me up | Cycles through new papers; the tour is the [T06 refresh](T06-viewer-actions.md) | `TopBar.tsx` (`CatchMeUp`) |
| Bottom toolbar | **Note** only (click the board to place it; v6 adds **Filter**, the [T09 refresh](T09-ranked-list.md)) | `client/client/pinboard/Toolbar.tsx` |
| "N changes · the agent is waiting · Update suggestions", the change list, "See what it did" | Not built: only on the static demo board (F17) | `client/public/landing/demo-board.html` |
| Help / the key | Not built | — |

## What's left (v6)

The spec is the v6 demo board's toolbar and its "Update suggestions" flow (`client/public/landing/demo-board.html`), [`shots-v5/23-changes-list.png`](../../mockups/shots-v5/23-changes-list.png), [`shots-v5/24-update-log.png`](../../mockups/shots-v5/24-update-log.png) and [`shots-v6/8-help-key.png`](../../mockups/shots-v6/8-help-key.png).

**The board's title** (F23): `TopBar` reads `GET /api/v1/boards/:id` (`boardApi.get`, added by [T16](T16-start-and-home-pages.md)) and shows the title, with the question as its tooltip; the room ID only while it loads.

**The agent in the face pile** only while `agentActive` is true: read from `GET /boards/:id` on load and on window focus, and kept current from the board's SSE stream (`/api/v1/boards/:id/events`, the `agent.active` and `agent.idle` events T08 records).

**Changes** (`client/client/pinboard/changes.ts`): this viewer's own edits since their last Update suggestions, kept per board in `sessionStorage`:

| Change | Recorded when | Entry |
| --- | --- | --- |
| `moved` | A person moves a paper card (the store side effect that sets `pinnedByHuman`, source `user`) | `{type, paperId}` |
| `link_added`, `link_renamed`, `link_hidden`, `link_removed` | The [T14 refresh](T14-board-editing.md)'s link editor | `{type, from, to, kind, label?}` |
| `note_added`, `note_pinned` | A person creates a note, or pins one to a paper | `{type, text, paperId?}` |
| `note_unpinned`, `note_removed` | A person drags a note from before this session off its paper, or deletes one | `{type, text, paperId?}`, the paper it was pinned to |
| `voted` | `castVote` succeeds (`client/client/widgets/votes.ts`) | `{type, paperId, decision}` |
| `cluster_renamed` | A person renames a cluster frame | `{type, clusterId, label}` |

Repeated changes to the same thing collapse (moving a paper three times is one `moved`). The JSON sent to the agent is `{since: <ISO time>, changes: [{…, at}]}`, the `<board-changes>` contract (`harness/harness/acp/mapping.py` already maps the `tldraw://<boardId>/changes` resource).

**The toolbar** (`Toolbar.tsx`): with changes, "N changes · the agent is waiting · **Update suggestions**"; clicking "N changes" opens a list of them in plain words ("You moved Daugherty-Lopès 2024", "You pinned a note to Ibáñez-Molero 2026").

**Update suggestions** calls `chatBus.ask({ text: "Update suggestions", resources: [{ uri: "tldraw://<boardId>/changes", mimeType: "application/json", text: <the JSON> }] })` (T05 refresh) and clears the changes. When that turn ends with `end_turn`, a toast says "Done. The agent caught up with your changes." with **See what it did**, which opens the chat scrolled to that turn.

**What the master does with it** is already in its instruction ("<board-changes>: call `get_board` first…"); with [H04](../agent-harness/H04-first-run-in-90-seconds.md) the re-rank is `rank_papers`. A scripted harness test pins it down: an Update suggestions prompt with a `moved` and a `voted` change leads to `get_board`, then `rank_papers`, and no `add_papers` for the moved paper.

**Help** (`client/client/pinboard/Help.tsx`, a **?** at the bottom right): the v6 key, explaining the cards (In your collection, Suggested · fit, the red rank number), the corner badges (New, Split vote, Reading…, ✓ Kept, Discarded), the three kinds of string (red cites, dotted similar, blue yours), notes and clusters.

**Tasks:**

- [x] `TopBar.tsx`: title and question; agent avatar from `agentActive`.
- [x] `client/client/pinboard/changes.ts` and `changes.test.ts` (recording, collapsing, the JSON); hooks in `sideEffects.ts` and `votes.ts`.
- [x] `Toolbar.tsx`: the changes counter, list and Update suggestions; the "See what it did" toast (`ChatPanel` exposes "scroll to turn").
- [x] `client/client/pinboard/Help.tsx`.
- [x] The harness's Update suggestions case, in its own file: `harness/tests/test_update_suggestions.py`.

**As built (Oct 21):**

- Collapsing: the latest move, vote or name of a thing wins; naming a link you drew this session folds into its `link_added`, and deleting it drops both; a note added and then pinned is one `note_added` with its `paperId`, which follows the note's text as you type, its unpinning and its deletion. A note from before this session that you unpin or delete is a `note_unpinned` or `note_removed` of its own, with its text and the paper it was pinned to. Undo in the link editor's toasts puts that link's changes back. Note entries carry the note's shape ID inside the browser only; the JSON is exactly `{since, changes: [{type, …, at}]}`, and `since` is when this list started (the last Update suggestions, or the first visit this session).
- The changes come from `sideEffects.ts` (papers moved, cluster frames renamed, note text and deletes), `editing/pinNotes.ts` (`note_added`, `note_pinned`, `note_unpinned`), the [T14](T14-board-editing.md) link handle and editor, and `castVote`.
- Update suggestions (`changes.ts` `updateSuggestions`) also toasts "The agent is updating suggestions with your N changes…", as the demo board does; "Done. The agent caught up with your changes." waits for the next turn whose prompt is "Update suggestions" to end with `end_turn`. The chat reports ended turns and opens at a turn through `chatTurns` in `chatBus.ts` (`ChatPanel` marks each turn with `data-turn`).
- The board's title falls back to its question, then the room ID; the agent's avatar follows `agentActive` from `GET /boards/:id` (on load and window focus) and the SSE stream's `agent.active` / `agent.idle`.
- Help lists the editing gestures this board has (double-click to edit a note or rename a cluster; scroll to move, ⌘-scroll to zoom, ⌘Z), not the demo's PDF drop or cluster resizing.

**Acceptance criteria (refresh, replacing 1 to 5 above for v6):**

1. The top bar shows the board's title, not its ID.
2. With a teammate and an active chat, the face pile shows both people and the agent; the agent's avatar goes within a minute of its harness ending.
3. Moving a paper and pinning a note shows "2 changes · the agent is waiting"; the list names both; Update suggestions sends one prompt carrying both changes and resets the counter.
4. When that turn ends, "Done. The agent caught up with your changes." appears, and See what it did opens the chat at that turn (demo-script step 7).
5. Help explains every card, badge and string style on the board.

## Goal

The board looks and works like the mockups (v5, which keeps v4's bars), not like a drawing app: tldraw's own toolbars and menus are gone, and in their place is v4's chrome. A top bar with the board's title and question, "Looking for", who's here (the agent included), "Catch me up" and Chat; a bottom bar with Note and, after edits, "N changes · the agent is waiting · Update suggestions"; and a help button with the legend.

## Context

- **Visual spec:** [v4 mockup](../../mockups/README.md), every screenshot in `docs/mockups/shots-v4/` (top bar and bottom bar in `1-overview.png`; the changes bar in `5-named-link.png` and `9-note-pinned.png`). v5 keeps the bars (`shots-v5/0-board.png`; the changes bar in `11-note-drop.png`) and adds two lines to the help panel and its figure switch.
- v4: "After edits, 'N changes · the agent is waiting' offers Update suggestions, as agreed in the brainstorm: you edit, then the agent catches up."
- Today `Room.tsx` renders tldraw's full default UI inside the multiplayer starter's `RoomWrapper` header.

## Scope

**In:** hiding tldraw's default UI; the top bar; the bottom bar; the changes counter and "Update suggestions"; help and legend; layout of the docked panels (ranked list, filter, chat) around the paper widgets; toasts.

**Out:** what each panel does (ranked list and filters: T09; chat: T05; paper widgets: T10); drawing links and pinning notes (T14); the agent's response to "Update suggestions" and "Catch me up" (harness owner).

## Design

**Hiding tldraw's UI.** `<Tldraw components={…}>` sets these to `null`: `Toolbar`, `StylePanel`, `MainMenu`, `PageMenu`, `NavigationPanel`, `HelpMenu`, `ActionsMenu`, `QuickActions`, `ZoomMenu`, `Minimap`, `HelperButtons`, `MenuPanel`, `SharePanel`, `DebugPanel`, `DebugMenu`, `PeopleMenu` (all names checked in tldraw 5.5's `TLUiComponents`). `ContextMenu`, `KeyboardShortcutsDialog`, `Toasts` and `Dialogs` stay. The multiplayer starter's `RoomWrapper` header is replaced by the top bar.

**Top bar** (`client/client/chrome/TopBar.tsx`), left to right as in v4:

| Item | Behaviour |
| --- | --- |
| Logo, board title, question | From `GET /boards/:id` (T08); clicking the title or question edits it (`PATCH`) |
| "Looking for" switch | The board's goals (T08); sets T01's per-viewer `currentGoal`; effects in T09 |
| Face pile | Avatars from tldraw presence (`editor.getCollaborators()` plus this viewer), coloured as their cursors; a robot avatar when the agent is active on this board (T08's `agent.active` and `agent.idle` events, fed by T03's harness registry) |
| "Catch me up (N)" | N = papers added since this viewer's last visit (T08); sends the prompt "Catch me up" on this viewer's chat connection (T05, opened if needed); the tour itself runs in the paper widgets, with the agent's line in the actions widget under each node (T06, T10); hidden when N is 0 |
| Chat | Opens and closes the chat panel (T05) |

**Bottom bar** (`client/client/chrome/BottomBar.tsx`), centred:

- **Note:** click places a note at the centre of the view; drag it onto a paper, or onto any widget of the open paper, to pin it there (T14, T10).
- **Changes:** after this viewer's own edits, "N changes · the agent is waiting" and an **Update suggestions** button. N counts edits since this viewer's last prompt, from T01's side-effect handlers: papers moved, links drawn, named, hidden or deleted, notes added or pinned. **Update suggestions** sends the prompt "Update suggestions" with the change list attached as a resource block (`tldraw://<boardId>/changes`, T07), then resets N. What the agent does with it (re-rank, re-run around the changed papers, respect removed links) is the master's job.

**Help** (`?`, bottom right): a popover "How to read the board": squares are in your collection (seed or kept), circles are suggestions coloured by fit for the current goal, NEW means nobody has voted yet, a dashed ring means the agent is reading, a check means kept, the split mark means a split vote; link kinds (cites, similar, your own); "Drop a note on a paper to pin it there."; "Click an open paper again for more." (v5); keyboard basics. It also holds T10's switch for showing the figure in an opened paper's first view.

**Panel layout** (v4 positions): ranked list top left (T09), filter bottom right (T09), chat top right (T05); an opened paper's widgets (T10) fill the space between them, in two columns when the list and the chat are both open. Panels overlay the canvas rather than shrink it, so the board never jumps. Below 900 px wide, panels open as full-height sheets, one at a time.

**Toasts** for confirmations, as in v5 ("Note pinned to Liu 2022. It moves with the paper."), using tldraw's `Toasts`.

## Tasks

- [ ] `client/client/chrome/TopBar.tsx`, `BottomBar.tsx`, `Help.tsx`, `FacePile.tsx`, `changes.ts` (counter and change list, pure and tested).
- [ ] `Room.tsx`: `components` overrides; replace `RoomWrapper`; panel layout.
- [ ] Wire "Catch me up" and "Update suggestions" to T05's connection and T07's context builder.

## Acceptance criteria

1. No tldraw toolbar, style panel, page menu or main menu is visible; the top and bottom bars match the v4 screenshots in layout and wording.
2. Two people and an active chat on one board show three avatars, one of them the agent's; the agent's disappears within a minute of its harness ending.
3. With three papers added since Ana's last visit, "Catch me up 3" starts the tour in the first paper's widgets; after she's seen them, the badge disappears.
4. Moving a paper and naming a link shows "2 changes · the agent is waiting"; Update suggestions sends one prompt carrying both changes and resets the counter.
5. Help explains every node and link style on the board.

## Tests

- `client/client/chrome/changes.test.ts`: which store changes count, merging repeated moves of the same paper into one change, the change list's JSON.
- Manual: criteria 1 to 3 side by side with the v5 mockup (v4 for the bars), recorded for T12.

## Risks

- **Hidden UI hides features people expect** (undo, zoom): keyboard shortcuts still work, and Help lists them; add a small zoom control later if testers ask.
- **"Changes" counts only this viewer's edits:** teammates' edits arrive through sync but don't add to Ana's counter; v4 shows one counter per person, so this matches.

## References

- [v4 mockup and its README](../../mockups/README.md)
- [tldraw: hiding UI components](https://tldraw.dev/examples/ui-components-hidden)
