# T14: Editing the board (v4): links and pinned notes

| Field | Value |
| --- | --- |
| Lane | Browser (+ T08 for removed links) |
| Size | M |
| Depends on | T01, T08 |
| Unblocks | T13 (the changes counter), T12 |
| Milestone | M4 |
| Status | Not started |
| Owner | TBD |

## Goal

Researchers shape the board by hand, the v4 way: drag papers, draw a link from a paper's **+** handle to another paper, click a link to name, hide or delete it, and drop a note onto a paper (or, v5, onto any widget of the open paper) so it's pinned there, moves with it and shows in its Team notes. Every one of these edits is stored with the board, attributed, and respected by the agent.

## Context

- **Visual spec:** [v4 mockup](../../mockups/README.md), "Editing" and "Three kinds of link"; screenshots `shots-v4/3-hover-handle.png`, `4-new-link-editor.png`, `5-named-link.png`, `6-edit-cites-link.png`, `2-move-paper-note-follows.png`, `9-note-pinned.png`. v5 adds "Drop a Note on any widget to pin it to that paper" (`shots-v5/11-note-drop.png`).
- v4's link rules: *cites* is a PubMed fact (you can label or hide it; the citation stays in the data); *similar* is the agent's guess (rename or delete it); your own links have whatever label you give them. Labels you write are always visible; "cites" and "similar" show only on hover or focus.
- [Concept: Rules when people and agents edit at once](../../Concept.md#collaboration-on-the-board): people win; human-touched shapes are locked for the agent.

## Scope

**In:** the hover handle and link drawing; the link editor; label visibility; deleting and hiding with the right rules per kind; pinning and unpinning notes; preventing people from deleting paper nodes (they discard instead); recording removed links for the agent.

**Out:** the link and binding data model (T01); the agent's link and note tools (T02); the changes counter UI (T13).

## Design

**Files** (`client/client/editing/`): `LinkHandle.tsx`, `LinkEditor.tsx`, `LinkLabels.tsx`, `pinNotes.ts`, `guards.ts`.

**Drawing a link.** Hovering a paper node shows a small **+** handle on its right edge (`components.InFrontOfTheCanvas`, positioned with `editor.pageToViewport`; hover from `editor.getHoveredShapeId()`). Dragging from it draws a rubber-band line; dropping on another paper creates a built-in arrow bound to both cards with meta `kind: "user"`, `by: <memberId>`, an empty label, and opens the link editor to name it. Dropping anywhere else cancels. If a link already joins the two papers, the editor opens on that link instead.

**Link editor** (clicking a link opens a small popover at the click point):

| Kind | Name | Hide | Delete |
| --- | --- | --- | --- |
| `cites` (PubMed) | Adds your label; "cites" stays as the kind | Sets `hiddenByHuman` (hidden for everyone; "the citation stays in the data") | Not offered |
| `similar` (agent) | Renames it (your label) | Sets `hiddenByHuman` | Deletes it and records it in T08's `removed_links`, so the agent never draws it again |
| `user` (yours or a teammate's) | Edits the label | Sets `hiddenByHuman` | Deletes it |

Every edit sets `meta.editedByHuman` and `meta.labelBy` on the link, so the canvas MCP never relabels or unhides it (T02).

**Label visibility.** A label someone wrote is the arrow's own text label, so it's visible to everyone at all times. The kinds "cites" and "similar" are not stored as text: `LinkLabels.tsx` draws a small pill with the kind on the link under the pointer, on a focused link, and on every link of the open paper (T10).

**Pinning notes.** The bottom bar's **Note** (T13) can be dragged onto the canvas:

- Dropped on a paper: a note is created beside the paper (placed so it doesn't overlap) with a `note-pin` binding to it (T01, props `{dx, dy}` from the note's and the paper's top-left corners), and a toast says "Note pinned to Liu 2022. It moves with the paper."
- Dropped on any widget of the open paper (v5): the widgets sit outside the canvas, so T10's `PaperWidgets` says which paper is under the pointer; T10 opens Team notes with its input focused, and Enter creates the note, pinned the same way.
- Dropped on empty canvas: a free note.
- Dragging an existing note onto a paper pins it; dragging a pinned note well away from its paper (more than one node width) unpins it, with a toast.
- Notes carry `meta.author` (T01), and their author's name and colour show at the bottom, as in v4.

**Guards** (`guards.ts`, store side effects):

- `registerBeforeDeleteHandler('shape', …)` returns `false` for a person deleting a `paper-card` (they Keep or Discard instead) or a `cites` link (they hide it instead); a toast explains.
- Arrows a person draws with tldraw's own arrow shortcut get `kind: "user"` automatically, so every link has a kind.

**Removed links** (T08). `PUT /api/v1/boards/:id/removed-links` with `{from, to, kind}`; `get_board` returns them as `removedLinks`, and `link_papers` skips them (T02).

## Tasks

- [ ] `client/client/editing/` components and `guards.ts`.
- [ ] Note dragging from T13's bottom bar; pin and unpin via the `note-pin` binding; drops on T10's widgets.
- [ ] T08: the `removed_links` table and route (small addition to T08's migration).

## Acceptance criteria

1. Hovering a paper shows the **+** handle; dragging it to another paper creates a link and opens the editor; naming it "same patients, other method" shows the label to everyone.
2. A `cites` link can be labelled and hidden but not deleted; a hidden one disappears for everyone.
3. Deleting a `similar` link removes it for everyone, and the agent's next `link_papers` for that pair is skipped.
4. "cites" and "similar" pills appear only on hover, focus or when the paper is open.
5. Dropping a note on Liu 2022, or on one of its open widgets, pins it: moving Liu 2022 moves the note in every browser, and the note shows in Liu 2022's Team notes.
6. Pressing Delete on a selected paper node does nothing except a toast pointing to Discard.

## Tests

- `client/client/editing/guards.test.ts`: the delete rules by shape and kind.
- `client/client/editing/linkEditor.test.ts`: which actions are offered per kind, and the meta each one writes.
- Manual: the two-browser checks in criteria 1, 3 and 5, recorded for T12.

## Risks

- **tldraw's own arrow interactions** (dragging arrow ends, its default label editing) may fight the editor popover: arrows keep tldraw's handles, and double-click label editing is redirected to the popover.
- **Pinned notes overlapping as papers move:** the binding keeps the note's offset; if two papers' notes collide after a move, people can drag them, and that drag keeps the pin.

## References

- [v4 mockup and its README](../../mockups/README.md)
- [tldraw bindings](https://tldraw.dev/sdk-features/bindings), [sticker bindings example](https://tldraw.dev/examples/sticker-bindings), [side effects](https://tldraw.dev/sdk-features/side-effects)
