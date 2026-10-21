# T15: Graph layout and strings on the v6 board

| Field | Value |
| --- | --- |
| Lane | Board + Browser + Harness |
| Size | M |
| Priority | P0 |
| Depends on | — |
| Unblocks | [D04](../discovery/D04-clusters-from-data.md) (frames that fit cards), the [T14 refresh](T14-board-editing.md) (link editing on the strings), [H01](../agent-harness/H01-live-board-check.md)'s overlap check |
| Milestone | W1 Nothing broken |
| Status | Built on branch `w1/board` (Oct 20); the harness near-links step is on `w1/harness-bg`; H01's live overlap check pending |
| Owner | TBD |

## Goal

The agent's papers land on the board as a readable map: no two cards overlap, new papers ring around their nearest seed instead of running off in a row, each one is joined to that neighbour by a string as soon as it lands, and the card's red note says "cites N of your seeds" only when it does.

## Context

- Finding F6 (Oct 19 live board): 17 of 153 pairs of cards overlapped, the two seeds overlapped each other, and 18 cards sat in a 450 × 350 px patch. The server's layout (`client/server/layout.ts`) places nodes of `props.w × props.h` (48 × 48 for a new card, 40 to 80 as links grow), 88 px apart; since v6 the browser draws every paper as a 172 × 70 card centred on that node (`client/client/shapes/card.ts`, `CARD_W`, `CARD_H`, `cardOffset`). Seeds added over REST (`client/server/api.ts`, `postSeed`) use the same layout.
- Without `near`, `anchorFor` (`client/server/canvasTools.ts`) puts each paper beside the run's latest card, which makes a row.
- Finding F7: `apply_clusters`' grid (`client/server/clusterTools.ts`) uses `CELL = {w: 150, h: 130}`, narrower than a card.
- Finding F9: `link_papers` resizes nodes by their links (`resizeByLinks`), which v6 never shows, and which shifts the node box the layout reasons about.
- Finding F8: `card.ts`' `seedLinks` counts every arrow to a seed, of any kind, and the note says "cites N of your seeds"; the Oct 19 board had 38 links, all `similar`.
- The strings themselves are drawn by `client/client/pinboard/Strings.tsx` from the built-in arrows, which `getShapeVisibility` hides; that stays.

## Scope

**In:** one card size shared by server and browser; layout that keeps a card's footprint clear; ring placement around the run's first card; cluster grid cells that fit cards; no node resizing; a `similar` link from each placed paper to its `near`, written by the harness without a model; the card note's wording; the demo seed board checked against the new rule.

**Out:** moving cards that are already on old boards (the agent never moves cards; re-seed demo boards); citation links themselves ([D03](../discovery/D03-citation-links.md)); people editing links (T14 refresh).

## Design

**One card size** (`client/shared/shapes.ts`): `export const CARD_SIZE = { w: 172, h: 70 } as const`. `client/client/shapes/card.ts` imports it for `CARD_W` and `CARD_H`; the server's layout imports it too (decision D6: one source of truth for both sides).

**Footprint layout** (`client/server/layout.ts`):

```ts
// A paper card keeps at least a card's room, centred on its node, however small the node.
function footprint(b: Box): Box {
	const w = Math.max(b.w, CARD_SIZE.w)
	const h = Math.max(b.h, CARD_SIZE.h)
	return { x: b.x - (w - b.w) / 2, y: b.y - (h - b.h) / 2, w, h }
}
```

- `shapeBoxes` returns the footprint for `paper-card` shapes (other shapes keep their own box).
- `placeNear` and `placeInside` test `isFree` against `footprint({...spot, ...size})`.
- `ringSpots`' step is the footprint's long side plus `RING_GAP`: 172 + 40 = 212 px instead of 88.
- The returned spot is still the node's top-left, so cards keep their node and the browser's `cardOffset` keeps working.

**Ring around the run's first card** (`canvasTools.ts`, `anchorFor`): without `near`, anchor on the earliest card of this run (lowest `index` with this `runId`) instead of the latest, so a run's papers ring around one point.

**Cluster cells** (`clusterTools.ts`): `CELL = { w: CARD_SIZE.w + 2 * MARGIN, h: CARD_SIZE.h + 2 * MARGIN }` (220 × 118), and `LABEL_H` goes: a v6 card carries its own first-author label inside. A card's position in the grid centres the card, not the node, in its cell.

**No node resizing** (decision D23): `resizeByLinks` and `LINK_STEP` go from `linkPapers`; new cards keep `NODE_SIZE`'s minimum. The `link_papers` description drops "Nodes grow with their number of links"; `PAPER_STATE_PROPS` in `client/client/boardRules.ts` keeps `w` and `h` so old boards' resized nodes don't count as edits.

**Citations win over similarity** (`linkPapers`): a `similar` link between two papers already joined by a `cites` link (either direction) is skipped with the reason "already linked by a citation".

**Near links at placement** (harness, step 2 of the [after-placement steps](../agent-harness/README.md#shared-contracts)): `ProcessPapers` remembers each placed suggestion's `near` (from the `add_papers` arguments, which `candidates.note` sees) and, right after the citation step, calls `link_papers` with `{from: paper, to: near, kind: "similar"}` for every pair, in one call. This replaces `4c11405`'s "Link" step in the master's instruction: same strings, no model tokens. The context agent's later `similar` links are deduplicated by the canvas.

**The card note** (`client/client/shapes/card.ts`, `derive`): `seedLinks` becomes `seedLinksOf(editor, cardId)` returning `{cites, close}`: `cites` counts seeds this card points to with a `cites` arrow (the card is the arrow's `start` binding, the seed its `end`); `close` counts seeds joined by `similar` links. The top new card's note is "cites N of your seeds" when `cites > 0`, else "close to N of your seeds" when `close > 0`, else none. The widgets' `SeedsPop` already distinguishes "Cites" from "Linked to".

**The demo seed board** (`client/server/seedDemo.ts`): its hand-set positions are checked against the footprint rule by a test; positions that overlap are spread out (scale the layout around its centre until no two cards overlap).

## Tasks

- [x] `client/shared/shapes.ts`: `CARD_SIZE`; `client/client/shapes/card.ts` uses it.
- [x] `client/server/layout.ts`: `footprint`, footprint-aware `shapeBoxes`, `placeNear`, `placeInside`, `ringSpots`.
- [x] `client/server/canvasTools.ts`: `anchorFor` on the first card; `resizeByLinks` removed; the cites-over-similar skip; tool description.
- [x] `client/server/clusterTools.ts`: `CELL`, no `LABEL_H`, card-centred grid positions.
- [x] `client/client/shapes/card.ts`: `seedLinksOf` and the note wording.
- [x] `client/server/seedDemo.ts`: positions spread if the test finds overlaps.
- [ ] `harness/harness/agents/master/background.py` and `candidates.py`: remember `near`, the near-links step.
- [x] Tests (below).

## Acceptance criteria

1. 200 cards placed one after another never overlap as drawn (172 × 70 centred on each node) with the margin included, and the placement is deterministic.
2. A card placed `near` another sits on the first free ring around it, 212 px out, never closer than the margin to any drawn card.
3. Two seeds added over REST don't overlap.
4. `apply_clusters` puts 9 cards into a frame with no two drawn cards overlapping and every card inside the frame's inner box.
5. `link_papers` no longer changes `w`, `h`, `x` or `y` of any card; a `similar` link between two papers joined by `cites` comes back in `skipped` with "already linked by a citation".
6. A scripted master turn that places three papers with `near` ends with three `similar` links from them to their neighbours, and the model made no `link_papers` call.
7. A card whose only links to seeds are `similar` shows "close to N of your seeds", never "cites".
8. The demo seed board has no overlapping cards; [H01](../agent-harness/H01-live-board-check.md) reports 0 overlaps.

## Tests

- `client/server/layout.test.ts`: the existing tests rewritten for the footprint (the 88 px expectations become 212 px; "200 placements never overlap" uses drawn boxes); a new test for criterion 3 through `api.test.ts`'s seed route.
- `client/server/clusterTools.test.ts`: criterion 4.
- `client/server/canvasTools.test.ts`: criterion 5 (the "resizes nodes" assertion goes).
- `client/server/seedDemo.test.ts` (new): criterion 8 on the seed data.
- `client/client/shapes/card.test.ts` (new, pure part of `derive`): criterion 7.
- `harness/tests/test_master_board.py`: criterion 6.

## Risks

- **Old boards stay overlapped:** the agent never moves a card (Concept's rule); the demo board is re-seeded with `node server/seedDemo.ts demo` after this lands.
- **Rings 212 px apart spread a 20-card board wider:** the canvas zooms out; the ranked list and Catch me up don't depend on proximity. If it reads too sparse, `RING_GAP` is one constant.

## References

- [`docs/mockups/flashcard-v6.html`](../../mockups/flashcard-v6.html) and [v6 notes](../../mockups/README.md)
- [T02: canvas MCP and layout](T02-canvas-mcp.md)
- [Agent harness: after-placement steps](../agent-harness/README.md#shared-contracts)
