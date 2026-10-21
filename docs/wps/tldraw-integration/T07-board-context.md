# T07: What the agent sees: selection, the board and papers as images

| Field | Value |
| --- | --- |
| Lane | Browser + Harness (board half) |
| Size | M as planned; L for the Oct 20 refresh (nothing is built yet, plus `look_at_figure` and the export with strings) |
| Depends on | T04, T05 (T10 for paper pages) |
| Unblocks | T12 |
| Milestone | M3 (board), M4 (paper pages); the Oct 20 refresh is W3 The team edits |
| Priority | P2 (refresh) |
| Status | Not started, apart from the prompt mapping in the harness. Refresh (Oct 20): see What's left; depends on the [T05 refresh](T05-chat-panel.md) and, for `look_at_figure`, [D05](../discovery/D05-real-figures.md) |
| Owner | TBD |

## Where it stands (Oct 20)

| Part | State | Where |
| --- | --- | --- |
| Context tags in the user's message (`<selected-shape>`, `<viewport>`, `<board-changes>`, `<board-context>`, images) | Built on the harness side | `harness/harness/acp/mapping.py`, `harness/harness/board/prompts.py` (`BOARD_CONTEXT`) |
| The chat panel sending selected shapes, the viewport and its image | Not built: the panel sends text only | `client/client/chat/ChatPanel.tsx` |
| `_canvas/snapshot` | The browser answers with a "not supported yet" error (F22) | `client/client/chat/connection.ts`, `connection.test.ts` ("_canvas/snapshot gets a \"not supported yet\" error") |
| `look_at_board`, `look_at_paper` and the image plugin | Not built | — |
| PDF reader (for `paper_page`) | Not built and out of scope (T10's Phase B) | — |

## What's left (v6)

Everything in the Design below still stands, with these changes for v6 and for what exists now:

**Decision D25: the agent looks at a figure through its image URL, not a PDF page.** There is no PDF reader, so the `paper_page` snapshot target is dropped. Instead, a harness tool `look_at_figure(paper_id)` reads the card's `figure.imageUrl` (set by [D05](../discovery/D05-real-figures.md); via `get_board`'s paper or `get_figures`) and adds the image to the next model call as a user message with an `image_url` part, the same way the plugin adds snapshots (Token Factory takes images by URL). No browser is involved. Without a figure it returns `{ok: false, error: "This paper has no figure on the board."}`.

**The board in a snapshot.** v6 draws the links as strings in an overlay (`client/client/pinboard/Strings.tsx`), and `getShapeVisibility` hides the arrows, so `editor.toImage` would leave the strings out. The snapshot handler exports with the arrows visible (a per-export visibility override, or a temporary atom read by `getShapeVisibility`), so the picture shows the links as lines; papers render through `PaperCardShapeUtil.toSvg`.

**Where it lives:** the snapshot handler in `client/client/chat/snapshot.ts` (not `canvas/snapshot.ts` as the Tasks below say), registered next to `viewerActions.ts`; the prompt blocks (selection, viewport, "Include my view") in `client/client/chat/context.ts` as planned, appended by `ChatPanel.tsx`'s `send` alongside the T05 refresh's resources; the harness tools in `harness/harness/board/viewer.py` (`look_at_board`, `look_at_figure` instead of `look_at_paper`) and the plugin in `harness/harness/acp/images.py`.

**Tasks** (the original Tasks below, minus `paper_page`, plus):

- [ ] `look_at_figure` in `viewer.py`, through the same image plugin.
- [ ] Arrows visible during export.
- [ ] `connection.test.ts`: the snapshot test answers with a PNG instead of an error.

**Acceptance criteria (refresh):** criteria 1, 2, 3, 5, 6 and 7 below stand; criterion 4 becomes: "With a paper open that has a figure, 'what does this figure show?' makes the agent call `look_at_figure` (a tool card shows it) and describe the figure's panels, axes or drawing, not just its caption."

## Goal

The agent understands the board the way a person does: from what's selected, from a compact text summary, and from **pictures**. Nemotron 3.5 Super VL reads a screenshot of the board (cards, clusters, arrows, the legend) and a paper's pages (figures, drawings, charts, tables), not only their text. The researcher's prompt carries their selection and view; and when the agent needs to see more, it asks the researcher's browser for a snapshot itself.

## Context

- [Concept: ACP, step 3](../../Concept.md#acp-one-researchers-conversation): "the selected paper cards and highlights as embedded `resource` blocks, and a viewport screenshot as an `image` block"; [NVIDIA model routing](../../Concept.md#nvidia-model-routing): Super VL reads "the canvas screenshot" and papers' figures and pages.
- What we checked on Oct 18 ([group README: The model](README.md#the-model-nemotron-35-super-vl-on-token-factory)): through ADK to Token Factory, Super VL read the board mockup's cards, clusters and legend from `docs/mockups/shots/canvas.png` (about 1,400 prompt tokens), and described the UMAP and tissue-section panels of the figure in `card-full.png`. Reasoning comes back separately and doesn't pollute the answer.
- Contracts: "Prompt content" and `_canvas/snapshot` in the [group README](README.md#shared-contracts); decision D15.

## Scope

**In:** prompt context from the browser (selection, viewport summary, viewport image); the agent's `look_at_board` and `look_at_paper` tools and the `_canvas/snapshot` request behind them; putting images in front of the model correctly; the browser renderers for each snapshot target; tests on Super VL.

**Out:** the reader agent's own reading of full papers and figures from the discovery service (harness and discovery owners); continuous awareness between prompts; voice.

## Design

### 1. What the prompt carries (browser, `client/client/chat/context.ts`)

Built when the user presses Send:

1. **Text block:** what they typed.
2. **Selected shapes:** up to 20 from `editor.getSelectedShapes()`, each a `resource` block with `uri: tldraw://<boardId>/<shapeId>`, `mimeType: application/vnd.tldraw.shape+json` and compact JSON: `{shapeId, type, paperId?, title?, year?, status?, fit?, why?, text?, pinnedTo?, author? | createdBy?}` (`fit` and `why` for the viewer's current goal). Note, text and geo shapes get `text` from `editor.getShapeUtil(shape).getText(shape)`; frames carry their label and the paper IDs inside. Over 20: the first 20 plus "and N more selected". The open paper (`openPaperId`, T10) is added the same way when it isn't selected, shown as a "Context: Liu 2022" chip with × to leave it out (v5, `shots-v5/9-narrow.png`).
3. **Viewport summary:** a `resource` block `tldraw://<boardId>/viewport` with `{visiblePaperIds, visibleNoteCount, zoom}`.
4. **Viewport image** when "Include my view" is on (the default) and the page isn't empty: a text block "Picture of the researcher's current view of the board:", then an `image` block from the shared renderer (section 3, target `viewport`).
5. **From the PDF reader** (T10 Phase B): "Ask about this page" adds the rendered PDF page, and "Ask about this area" (drag a box on the page) adds just that crop, each preceded by a line like "Page 5 of Lindqvist 2024 (pmid:…), area the researcher marked:".
6. **From "Update suggestions"** (T13): a `resource` block `tldraw://<boardId>/changes` with this viewer's edits since their last prompt, as JSON: `[{type: "moved" | "linked" | "link_named" | "link_hidden" | "link_deleted" | "note_added" | "note_pinned", paperIds, label?, text?}]`. The agent re-ranks and re-runs around those papers and never undoes them (T02's rules).

Chips under the user's message show what was attached ("3 cards", "your view", "page 5"); clicking one focuses it locally (T06).

### 2. The agent asks to look (harness, `harness/harness/board/viewer.py`)

Two more session-bound tools in `BoardTools.viewer()`, alongside T06's:

| Tool | Signature | Asks the browser for |
| --- | --- | --- |
| `look_at_board` | `look_at_board(target: "viewport" \| "board" \| "papers", paper_ids: list[str] = [])` | The researcher's current view, the whole board, or just the named papers' cards and their neighbours |
| `look_at_paper` | `look_at_paper(paper_id: str, page: int = 1)` | One rendered page of the paper's PDF |

Each calls `await conn.ext_method("canvas/snapshot", {...})` (on the wire `_canvas/snapshot`) with a target from the [shared contract](README.md#shared-contracts): `look_at_board("viewport")` and `look_at_board("board")` send those targets, `look_at_board("papers", paper_ids)` sends `target: "shapes"` with `paperIds`, and `look_at_paper` sends `target: "paper_page"`. It waits up to 10 seconds, and returns a short JSON result to the model: `{"ok": true, "image": "board view, 1600×980, 41 cards visible"}` or `{"ok": false, "reason": "…"}`. The docstrings say when looking helps: layout and cluster questions, "what am I looking at", anything about a figure, chart or drawing.

**Getting the image in front of the model.** Token Factory's tool messages carry text only ([function calling](https://docs.tokenfactory.nebius.com/ai-models-inference/function-calling)), so the picture can't be the tool's result. Instead:

1. The tool puts the PNG bytes and its caption in a per-session "pending images" list on `BoardTools`.
2. An ADK plugin (`harness/harness/acp/images.py`, registered on the runner next to T04's trace plugin) implements `before_model_callback`: if images are pending, it appends one user `Content` to `llm_request.contents` with the caption as a text part and the PNG as `Part(inline_data=Blob(mime_type="image/png", data=…))`, then clears the list. ADK's LiteLLM path sends that as an OpenAI `image_url` part with a base64 data URL, which Super VL reads.
3. The image goes into that one model call only and isn't saved in the session history, so later turns don't pay for it again; the tool's text result (in history) records that the agent looked.

Because it's a plugin, it works for any agent in the runner, including the harness owner's `master`, with no change to their code (plugins reach `AgentTool` agents too, decision D8).

**Prompt blocks.** T04 owns the mapping and its tag names (`<selected-shape>`, `<viewport>`, `<board-changes>`, and `<board-context>` for anything else; see [T04](T04-acp-adapter.md)). This WP only builds the blocks in the browser and the image rules below. The harness drops images (and says so in a text part) only if the root agent's model isn't vision-capable ([I6](interfaces.md#i6-which-model-slots-take-images)); on Super VL that never happens.

### 3. Rendering snapshots (browser, `client/client/canvas/snapshot.ts`)

One renderer for prompt images and `_canvas/snapshot` requests (T05 registers it with `.onRequest('_canvas/snapshot', …)`):

| Target | How |
| --- | --- |
| `viewport` | `editor.toImage([...editor.getCurrentPageShapeIds()], { format: 'png', bounds: editor.getViewportPageBounds(), background: true, scale, pixelRatio: 1 })` |
| `board` | Same, with `bounds: editor.getCurrentPageBounds()` |
| `shapes` (with `shapeIds` and/or `paperIds`) | The named shapes and paper cards plus shapes bound to them by arrows, `bounds` = their union with a margin |
| `paper_page` | pdf.js renders the page from `GET /papers/:paperId/pdf` (T08) to an offscreen canvas; reuses the PDF reader's document if it has the same paper open (T10) |

- Size: `scale` is chosen so the long side is at most 1,600 px (the measured cost of such an image is about 1,400 tokens); `maxSide` in the request can lower it.
- T10's widgets are HTML over the canvas, outside `<Tldraw>`, so `editor.toImage` leaves them out: a `viewport` snapshot with a paper open shows the board and the node only, and its caption names the open paper ("Liu 2022 is open").
- Errors: no PDF, a page out of range, an empty board, or a hidden tab (`document.visibilityState !== 'visible'` can't render reliably) answer with a JSON-RPC error and a reason the agent can repeat to the person.
- The caption says what and where: "Whole board, 63 cards in 5 clusters" or "Page 5 of 14, Lindqvist 2024".
- Snapshots only happen on a prompt or an agent request in a live chat; nothing is captured in the background.

## Tasks

- [ ] `client/client/canvas/snapshot.ts`: the four targets, size cap, captions, errors.
- [ ] `client/client/chat/context.ts`: prompt blocks, chips, "Include my view".
- [ ] `client/shared/acpExt.ts`: `zod` schema for `_canvas/snapshot` params and result; `.onRequest` in T05's connection.
- [ ] `harness/harness/board/viewer.py`: `look_at_board`, `look_at_paper`, the pending-images list.
- [ ] `harness/harness/acp/images.py`: the `before_model_callback` plugin; register it in T04's runner.
- [ ] `harness/harness/acp/mapping.py`: image blocks with captions.
- [ ] Instruction paragraph (a constant in `harness/harness/board/`) telling agents what the context tags and the look tools are, used by `board_assistant` and offered to `master` through [I1](interfaces.md#i1-agent-factory-takes-the-boards-tools).
- [ ] Tests (below).

## Acceptance criteria

1. Select three paper cards and ask "what do these have in common?": Super VL's answer names those three papers and no others.
2. With nothing selected, "what am I looking at?" gets an answer about the visible cards and clusters that matches the screen.
3. "How is the board organised?" makes the agent call `look_at_board("board")` (a tool card shows it), and its answer names the clusters and roughly how many papers each holds.
4. With a paper open, "what does the figure on this page show?" makes the agent call `look_at_paper` (or uses the attached page) and describe the figure's panels, axes or drawing, not just its caption.
5. A snapshot request while the tab is hidden fails within 10 seconds, and the agent says it couldn't see the board instead of guessing.
6. After a turn that used a snapshot, the next model request in the session doesn't contain the image again (checked in the scripted test).
7. With "Include my view" off, no viewport image is sent.

## Tests

- **Keyless** (`harness/tests/test_board_vision.py`): the scripted model calls `look_at_board`; a fake ACP client answers `_canvas/snapshot` with `docs/mockups/shots/canvas.png`; assert the next `LlmRequest` has exactly one user `Content` with the caption and the PNG as `inline_data`, and the request after that has none.
- **Live on Super VL** (`harness/tests/live/test_vision_live.py`, run with `uv run pytest -m live`, skipped without `TF_API_KEY`):
  - Board screenshot: `canvas.png` as a prompt image; the answer mentions at least three of Tirosh, Smalley, Sade-Feldman, Lindqvist, Chen, Park, Ibrahim, and at least one cluster name.
  - Figure: `card-full.png`; the answer mentions UMAP or the tissue section.
  - Agent-initiated look: `board_assistant` on Super VL, asked "how is the board organised?", calls `look_at_board`; the fake client answers with `canvas.png`; the answer names a cluster ("Tumour ecosystem", "Checkpoint response" or "CD8 / CD4 T-cell states").
  - Thoughts separated: in every live answer, the final text contains no thought parts, and thought parts exist.
- **Browser** (`client/client/canvas/snapshot.test.ts`): the size cap and bounds selection as pure functions; `context.test.ts` for `toContextShape` and the 20-shape cap.

## Risks

- **A hidden or backgrounded tab** may not render: the 10-second timeout and an honest "couldn't see" keep the agent from guessing.
- **Cross-origin images in a snapshot** (a figure image served from another site) may be missing from the picture: board assets are same-origin (`/api/uploads`), and figure images should be proxied the same way when they arrive.
- **Wrong answers from a picture** (a misread title): the agent can confirm with `get_board`, and the instruction asks it to cross-check names against the board's data before acting on them.

## References

- [Token Factory: vision capabilities](https://docs.tokenfactory.nebius.com/api-reference/examples/vision-capabilities), [function calling](https://docs.tokenfactory.nebius.com/ai-models-inference/function-calling)
- [ACP extensibility](https://agentclientprotocol.com/protocol/extensibility), [content blocks](https://agentclientprotocol.com/protocol/content)
- [ADK plugins](https://adk.dev/plugins/)
- [tldraw editor and image export](https://tldraw.dev/docs/editor), [pdf.js](https://mozilla.github.io/pdf.js/)
