# Work packages

Work packages (WPs) split the design in [`docs/Concept.md`](../Concept.md) and [`docs/architecture.html`](../architecture.html) into pieces one person can pick up, build and check off. Each group of WPs has its own folder.

| Group | Folder | What it covers | Status |
| --- | --- | --- | --- |
| tldraw integration (T) | [`tldraw-integration/`](tldraw-integration/README.md) | The tldraw board and its custom shapes, the board service (sync rooms, canvas MCP and layout, ACP pipe, REST + SSE), the chat panel, ranked list and paper overlay, external agents, and the board-facing half of the harness (ACP adapter, canvas and viewer tools). Includes the interfaces with the harness and discovery owners. Model: Nemotron 3.5 Super VL on Token Factory. | Planned |

## How a WP is written

Every WP file follows the same outline, so they can be read side by side:

1. **Header table:** lane, size, dependencies, milestone, status and owner.
2. **Goal:** one paragraph on what is true when the WP is done.
3. **Context:** the diagram or section of the design it implements.
4. **Scope:** what is in and what is explicitly out.
5. **Design:** the contracts and choices someone needs to build it without asking.
6. **Tasks:** a checklist with the files each task touches.
7. **Acceptance criteria:** checks a reviewer can run.
8. **Tests, risks and references.**

Sizes are relative: **S** is a focused session, **M** is most of a day for one person, **L** needs splitting or two people. A WP is done when every acceptance criterion holds on a clean checkout and the README of the code it touches says how to run it.
