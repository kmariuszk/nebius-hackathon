# T13: Board chrome (v4): top bar, bottom bar, help

| Field | Value |
| --- | --- |
| Lane | Browser |
| Size | M |
| Depends on | T01, T05 (chat), T08 (board, counts, agent presence) |
| Unblocks | T09 (the "Looking for" control), T12 |
| Milestone | M4 |
| Status | Not started |
| Owner | TBD |

## Goal

The board looks and works like the v4 mockup, not like a drawing app: tldraw's own toolbars and menus are gone, and in their place is v4's chrome. A top bar with the board's title and question, "Looking for", who's here (the agent included), "Catch me up" and Chat; a bottom bar with Note and, after edits, "N changes · the agent is waiting · Update suggestions"; and a help button with the legend.

## Context

- **Visual spec:** [v4 mockup](../../mockups/README.md), every screenshot in `docs/mockups/shots-v4/` (top bar and bottom bar in `1-overview.png`; the changes bar in `5-named-link.png` and `9-note-pinned.png`).
- v4: "After edits, 'N changes · the agent is waiting' offers Update suggestions, as agreed in the brainstorm: you edit, then the agent catches up."
- Today `Room.tsx` renders tldraw's full default UI inside the multiplayer starter's `RoomWrapper` header.

## Scope

**In:** hiding tldraw's default UI; the top bar; the bottom bar; the changes counter and "Update suggestions"; help and legend; layout of the docked panels (ranked list, filter, chat, card); toasts.

**Out:** what each panel does (ranked list and filters: T09; chat: T05; card: T10); drawing links and pinning notes (T14); the agent's response to "Update suggestions" and "Catch me up" (harness owner).

## Design

**Hiding tldraw's UI.** `<Tldraw components={…}>` sets these to `null`: `Toolbar`, `StylePanel`, `MainMenu`, `PageMenu`, `NavigationPanel`, `HelpMenu`, `ActionsMenu`, `QuickActions`, `ZoomMenu`, `Minimap`, `HelperButtons`, `MenuPanel`, `SharePanel`, `DebugPanel`, `DebugMenu`, `PeopleMenu` (all names checked in tldraw 5.5's `TLUiComponents`). `ContextMenu`, `KeyboardShortcutsDialog`, `Toasts` and `Dialogs` stay. The multiplayer starter's `RoomWrapper` header is replaced by the top bar.

**Top bar** (`client/client/chrome/TopBar.tsx`), left to right as in v4:

| Item | Behaviour |
| --- | --- |
| Logo, board title, question | From `GET /boards/:id` (T08); clicking the title or question edits it (`PATCH`) |
| "Looking for" switch | The board's goals (T08); sets T01's per-viewer `currentGoal`; effects in T09 |
| Face pile | Avatars from tldraw presence (`editor.getCollaborators()` plus this viewer), coloured as their cursors; a robot avatar when the agent is active on this board (T08's `agent.active` and `agent.idle` events, fed by T03's harness registry) |
| "Catch me up (N)" | N = papers added since this viewer's last visit (T08); sends the prompt "Catch me up" on this viewer's chat connection (T05, opened if needed); the tour itself appears in the card (T06, T10); hidden when N is 0 |
| Chat | Opens and closes the chat panel (T05) |

**Bottom bar** (`client/client/chrome/BottomBar.tsx`), centred:

- **Note:** click places a note at the centre of the view; drag it onto a paper to pin it there (T14).
- **Changes:** after this viewer's own edits, "N changes · the agent is waiting" and an **Update suggestions** button. N counts edits since this viewer's last prompt, from T01's side-effect handlers: papers moved, links drawn, named, hidden or deleted, notes added or pinned. **Update suggestions** sends the prompt "Update suggestions" with the change list attached as a resource block (`tldraw://<boardId>/changes`, T07), then resets N. What the agent does with it (re-rank, re-run around the changed papers, respect removed links) is the master's job.

**Help** (`?`, bottom right): a popover "How to read the board": squares are in your collection (seed or kept), circles are suggestions coloured by fit for the current goal, NEW means nobody has voted yet, a dashed ring means the agent is reading, a check means kept, the split mark means a split vote; link kinds (cites, similar, your own); keyboard basics.

**Panel layout** (v4 positions): ranked list top left (T09), filter bottom right (T09), chat top right (T05), the card docked right (T10; to the left of the chat when both are open). Panels overlay the canvas rather than shrink it, so the board never jumps. Below 900 px wide, panels open as full-height sheets, one at a time.

**Toasts** for confirmations, as in v4 ("Note pinned to Liu 2022. It moves with the paper and shows in its card."), using tldraw's `Toasts`.

## Tasks

- [ ] `client/client/chrome/TopBar.tsx`, `BottomBar.tsx`, `Help.tsx`, `FacePile.tsx`, `changes.ts` (counter and change list, pure and tested).
- [ ] `Room.tsx`: `components` overrides; replace `RoomWrapper`; panel layout.
- [ ] Wire "Catch me up" and "Update suggestions" to T05's connection and T07's context builder.

## Acceptance criteria

1. No tldraw toolbar, style panel, page menu or main menu is visible; the top and bottom bars match the v4 screenshots in layout and wording.
2. Two people and an active chat on one board show three avatars, one of them the agent's; the agent's disappears within a minute of its harness ending.
3. With three papers added since Ana's last visit, "Catch me up 3" starts the tour in the card; after she's seen them, the badge disappears.
4. Moving a paper and naming a link shows "2 changes · the agent is waiting"; Update suggestions sends one prompt carrying both changes and resets the counter.
5. Help explains every node and link style on the board.

## Tests

- `client/client/chrome/changes.test.ts`: which store changes count, merging repeated moves of the same paper into one change, the change list's JSON.
- Manual: criteria 1 to 3 side by side with the v4 mockup, recorded for T12.

## Risks

- **Hidden UI hides features people expect** (undo, zoom): keyboard shortcuts still work, and Help lists them; add a small zoom control later if testers ask.
- **"Changes" counts only this viewer's edits:** teammates' edits arrive through sync but don't add to Ana's counter; v4 shows one counter per person, so this matches.

## References

- [v4 mockup and its README](../../mockups/README.md)
- [tldraw: hiding UI components](https://tldraw.dev/examples/ui-components-hidden)
