# D04: Clusters from data

| Field | Value |
| --- | --- |
| Lane | Discovery + Harness |
| Size | M |
| Priority | P2 |
| Depends on | [T15](../tldraw-integration/T15-graph-layout-and-strings.md) (cluster frames fit v6 cards), [H04](../agent-harness/H04-first-run-in-90-seconds.md) (the first run has time for one more step) |
| Unblocks | Demo beat 7 (drag a paper into a cluster); the [T14 refresh](../tldraw-integration/T14-board-editing.md)'s cluster editing |
| Milestone | W3 The team edits |
| Status | Built on branch `w3/clusters` (Oct 21); criterion 6 waits for the live check |
| Owner | TBD |

## Goal

After the first run, the board's papers sit in two to six named clusters of similar papers, drawn as v6's dotted areas with a taped label. The clusters come from the papers' embeddings, not the model's judgement; the names come from Lightning. A second run adds papers to the clusters that exist instead of making new ones.

## Context

- Finding F10: a real board has no clusters, because the papers MCP has no `cluster_papers`. The board side is built and waiting: `apply_clusters` and `label_cluster` (`client/server/clusterTools.ts`) are listed by the canvas MCP as soon as the papers MCP lists `cluster_papers` (checked every 30 s), and they expect the result shape in [interfaces.md I5](../tldraw-integration/interfaces.md#i5-what-the-board-service-needs-from-the-papers-mcp) (`client/server/papersClient.ts`'s `clusterResult`).
- `apply_clusters` reuses an existing frame by `clusterId`, moves only agent papers nobody touched, and keeps pinned notes beside their papers. New papers placed `near` a clustered paper go into its frame.
- Concept's design: "After the first run, the discovery service clusters the board's papers by similarity and the layout service arranges them; Lightning names each cluster" ([Concept: Agent design](../../Concept.md#agent-design), step 11).
- The demo script's beat 7 drags a paper into the "Tumour ecosystem" cluster; today that only works on the static demo board.

## Scope

**In:** the `cluster_papers` tool; a model-free harness step that clusters a board once; the master able to rename a cluster when asked.

**Out:** frames and layout (built, fixed for v6 cards by T15); people's cluster editing (T14 refresh); re-clustering a board that already has clusters (later runs place `near`).

## Design

**`cluster_papers(paper_ids, k=None)`** (`discovery/discovery/clusters.py`, tool in `server.py`), 2 to 500 IDs:

1. Records (`self._papers`) and unit vectors (`self._paper_vectors(Embedder.from_env(...), papers)`, so stored vectors are reused).
2. `k`: the argument if given; else 1 when there are fewer than 6 papers, else `clamp(round(sqrt(n / 2)), 2, 6)`.
3. k-means++ on the unit vectors (cosine), numpy only, seeded with 0, at most 25 iterations, so the same papers always give the same clusters.
4. A cluster of one paper joins the cluster whose centroid is closest.
5. Each cluster's medoid (the member with the highest mean similarity to the others) gives `clusterId = "c-" + slug(medoid paper ID)` (the slug rule from `client/shared/ids.ts`): adding a paper rarely changes the medoid, so `apply_clusters` finds the same frame next time.
6. Members ordered by similarity to the medoid, most similar first.
7. `similarities`: for every paper, its 3 nearest neighbours `{a, b, similarity}` (cosine, rounded to 3 places), deduplicated.
8. Labels: one Lightning request per cluster, in parallel, through Token Factory's chat completions (`LIGHTNING_MODEL`, `response_format: json_object`, temperature 0): "Name this group of papers in 2 to 4 words a biologist would use, from their titles. Reply {\"label\": \"…\"}", with up to 8 member titles. A failure or an empty answer gives `label: null`.
9. Return `{clusters: [{clusterId, paperIds, label}], similarities}`; papers that couldn't be loaded or embedded go in `skipped` and in no cluster.

**Stretch (optional):** blend citation overlap into similarity, Concept's `0.6 × cosine + 0.4 × citation overlap`, using [D03](D03-citation-links.md)'s links (overlap = shared references over the smaller list). Behind an argument `blend: bool = False`.

**The harness step** (step 4 of the [after-placement steps](../agent-harness/README.md#shared-contracts), in `ProcessPapers.after_turn`): at the end of the master's turn, a `Step` named `clusters` with `board.canvas("get_board", "apply_clusters")`:

1. If the canvas MCP doesn't list `apply_clusters`, stop.
2. `get_board`: if any cluster is the agent's (`labelGenerated` or made by the agent) or a person made one, stop: the board already has its clusters.
3. If the board has fewer than 6 papers, stop.
4. `apply_clusters()` with no `paperIds`, so every paper on the board is considered and people's papers stay put.

It runs once per board per chat (a flag on `ProcessPapers`), after `rank_papers` has written the fits; the reading started earlier carries on, since frames move cards without touching their props.

**The master:** its canvas filter gains `apply_clusters` and `label_cluster`, and its instruction one line under Follow-ups: "Rename a cluster with `label_cluster` when the researcher asks; never re-cluster a board that has clusters."

## Tasks

- [x] `discovery/discovery/clusters.py`: k-means++, medoids, IDs, neighbours (pure functions over a matrix). (The best of 10 k-means++ runs from seed 0, so one unlucky start doesn't split a group and leave a stray paper alone.)
- [x] `discovery/discovery/service.py`: `cluster_papers` (records, vectors, labels); `server.py`: the tool. (In `clusters.py`, called from `server.py` like `citation_links`; `service.py` is unchanged.)
- [x] `discovery/tests/test_clusters.py`.
- [x] `harness/harness/agents/master/background.py`: the cluster step; `master/agent.py`: canvas filter and instruction line. (The flag is set once the board has clusters or `apply_clusters` succeeded; a failed call writes nothing, so the next turn tries again.)
- [x] `harness/tests/test_master_board.py`: the step runs once and only on a board without clusters. (In `harness/tests/test_clusters_step.py`, beside the citation step's tests.)
- [x] `discovery/README.md`, [interfaces.md I5](../tldraw-integration/interfaces.md#i5-what-the-board-service-needs-from-the-papers-mcp) status.
- [ ] Stretch: the citation-overlap blend (`blend`), not built.

## Acceptance criteria

1. On a fixed matrix of 12 vectors in three tight groups, `cluster_papers` returns three clusters with the expected members, the same output on every call.
2. A lone paper far from the rest joins the nearest cluster; no cluster has one member when there are 6 or more papers.
3. Adding one paper close to an existing cluster keeps every `clusterId` the same.
4. A Lightning failure gives `label: null` and the clusters still come back.
5. A scripted master turn on a board with 8 papers and no clusters ends with one `apply_clusters` call; on a board that has a cluster, none.
6. [H01](../agent-harness/H01-live-board-check.md) on the five demo seeds ends with 2 to 6 labelled frames and no overlapping cards inside them; running the prompt again makes no new frames.

## Tests

- `discovery/tests/test_clusters.py`: criteria 1 to 4 (the matrix and a stubbed label call).
- `client/server/clusterTools.test.ts` stays green against the real result shape (one fixture taken from a `cluster_papers` call).
- Harness: criterion 5.

## Risks

- **Moving cards into frames mid-run surprises people:** it happens once, right after the first placement, only to agent cards nobody touched (the canvas enforces this).
- **Labels are generic** ("Melanoma immunology"): people can rename them (T14 refresh), and a person's name is never overwritten.
- **Embedding similarity groups by topic words, not method:** acceptable for a first view; the stretch blend adds citations.

## References

- [interfaces.md I5](../tldraw-integration/interfaces.md#i5-what-the-board-service-needs-from-the-papers-mcp)
- [`client/server/clusterTools.ts`](../../../client/server/clusterTools.ts)
- [Concept: Agent design](../../Concept.md#agent-design)
