# discovery

The papers MCP: the paper tools every agent uses, served over streamable HTTP. Papers found by any tool are cached in SQLite and deduplicated by DOI, PMID, PMCID, arXiv, OpenAlex and Semantic Scholar IDs. Their embeddings are kept in LanceDB (`data/vectors`), keyed by paper ID, text and model, so a paper is embedded once until its abstract or the model changes.

```zsh
uv run python -m discovery   # http://127.0.0.1:8001/mcp
uv run pytest                # offline tests
```

Keys come from the repo-root `.env` (see `.env.example`). Each source runs on its own: one without a key, or one that fails, is listed in the result's `skipped` and the rest still answer.

## Tools

| Tool | Input | Output |
| --- | --- | --- |
| `search` | `query`, `limit`, `sources` (pubmed, openalex, web), `since` | `papers` (summaries with `foundBy`), `countsBySource`, `skipped` |
| `find_candidates` | `seed_ids`, `exclude_ids`, `strategies` (pubmed_links, citing, recommend, keyword, web), `since`, `limit`, `query` | `candidateIds` (found by most strategies first), `countsByStrategy`, `skipped` |
| `score_candidates` | `question`, `candidate_ids`, `seed_ids`, `limit` | `top` (ID, title, year, `score`, `questionSimilarity`, `seedSimilarity`, `closestSeed`), `scored`, `skipped` (candidates not found or not embedded) |
| `rerank` | `goal`, `paper_ids` (up to 100), `seed_ids`, `exclude_ids`, `k`, `backend` (super_vl, rerank_vl) | `ranked` (summary, `rank`, `score`, `reason`), `backend`, `model`, `seconds`, `candidates`, `skipped` |
| `citation_links` | `paper_ids` (2 to 200) | `links` (`from` cites `to`, both among `paper_ids` and under the IDs given; `source` pubmed from PubMed's reference lists, or openalex from OpenAlex's `referenced_works` for papers without a PMID), `skipped` |
| `cluster_papers` | `paper_ids` (2 to 500), `k` | `clusters` (`clusterId`, `paperIds` under the IDs given and most central first, `label` or null), `similarities` (`a`, `b`, `similarity`: each paper's 3 nearest neighbours), `skipped` (papers not found or not embedded) |
| `resolve_seed` | `doi`, `pmid` or `title` | full paper record |
| `get_paper` | `paper_id` | full paper record |
| `get_fulltext` | `paper_id`, `max_chars` (40,000) | `source` (pmc, web, abstract), `url`, `sections` (`title`, `text`), `figures` (`figureId`, `label`, `caption`, `imageUrl`), `truncated`, `omittedSections`, `skipped` |
| `get_figures` | `paper_id` | `paperId`, `source`, `figures` (`figureId`, `label`, `caption`, `imageUrl` or null), `skipped` |
| `check_quotes` | `paper_id`, `quotes` | each quote with `verbatim`, `section` and a `link` that highlights it (`#:~:text=`) |

`since` takes `YYYY`, `YYYY-MM` or `YYYY-MM-DD` (a year or month counts from its first day); anything else is a tool error naming those formats. An optional argument sent as a placeholder (`"None"`, `"none"`, `"null"`, `"NULL"`, `"undefined"` or `""`) counts as left out.

Paper IDs look like `doi:10.1038/s41586-021-03704-y`, `pmid:34290406`, `pmcid:PMC9187974` or `arxiv:2401.01234`. Scoring is embedding similarity only so far.

### Where full text comes from

`get_fulltext` tries, in order: PMC's JATS XML through E-utilities (`efetch db=pmc`, which also serves author manuscripts), arXiv's HTML page through Tavily Extract, then the open-access PDF or the DOI landing page through Tavily Extract. A page under 3,000 characters is treated as a landing page or paywall. When nothing works it returns the abstract with `source: "abstract"`, and `skipped` says why. Full text is cached in SQLite, so `check_quotes` checks against every section, including the ones `max_chars` cut. Back matter (acknowledgements, funding, author contributions and so on) is dropped, Methods sections go last, and no section takes more than a sixth of the budget.

### Figures

Figures come from PMC only: label and caption from the JATS XML, and the image URL from the PMC article page (`discovery/figures.py`), since the JATS names the image file but not its CDN path. Each `<figure id>` on the page holds an `<img src>` on `cdn.ncbi.nlm.nih.gov`; figures are matched by ID, then by image file name. A page without a `<figure>` is a block page, which PMC sometimes sends: it's fetched twice more, 2 s apart. The URLs are cached with the full text. When no figure got one, `get_figures`'s `skipped` says why (`"figure images: PMC's article page was a block page 3 times"`). Only "no figure on PMC's article page matched" is cached with the text; after a block page or a network error, a read fetches the page again, as it does for a full text cached before image URLs existed, unless the page failed less than 10 minutes ago in this process (`PAGE_RETRY_SECONDS`): then it reports the same reason without fetching. `get_figures` reads the same cached full text as `get_fulltext`, so the background can fetch figures without the whole text.

### Clusters

`cluster_papers` (`discovery/clusters.py`) groups papers by their embeddings, the same stored vectors `score_candidates` uses, with no model judging: k-means++ on the unit vectors by cosine similarity, in numpy, the best of 10 runs from seed 0, each at most 25 rounds, so the same papers always give the same clusters. `k` is the argument if given; else 1 under 6 papers, else round(√(n/2)) between 2 and 6. A cluster of one paper joins the cluster whose centroid is closest. Each cluster's medoid (the paper with the highest mean similarity to the others) comes first in its `paperIds`, the rest by similarity to it, and names it: `clusterId` is `c-` and the medoid's ID with every character outside `[A-Za-z0-9_-]` as `_` (the board's slug rule), so adding a paper rarely changes it and the board's `apply_clusters` fills the same frame. Lightning (`LIGHTNING_MODEL`, default `nvidia/Nemotron-3_5-Lightning`) names each cluster in 2 to 4 words from up to 8 of its titles, one request per cluster, in parallel, each with a 60-second timeout and reasoning off; when Lightning fails or gives no name, Super VL (`SUPER_VL_MODEL`) is asked once the same way, and when it fails too `label` stays null for the researcher or `label_cluster` to fill. Papers that can't be loaded or embedded are in `skipped` and in no cluster; fewer than 2 that can is a tool error. The board service calls it from `apply_clusters`, which its canvas MCP lists once this server lists `cluster_papers`.

### How ranking works today

Two steps, cheap then expensive:

1. `score_candidates` embeds every candidate's and seed's title and abstract with Qwen3-Embedding-8B on Token Factory (it serves no Nemotron embedder) and scores each candidate by the mean of its cosine similarity to the question and to the closest seed, or the question's alone without seeds. It handles hundreds of candidates in a few seconds, and in well under a second once their vectors are stored. The score is a formula, so it can be broken down into its two similarities.

   Texts go to the embeddings endpoint 32 to a request, at most `EMBED_CONCURRENCY` (default 4) requests at once across the server, with timeouts of 15, 30 and 90 s for the three tries: a batch usually answers in about 2 s, but some take minutes, so a slow one is sent again at once. A request that answers 429 or 5xx is tried twice more, after 2 s and then 5 s (or what `Retry-After` asks). Candidates still without a vector are left out and `skipped` says how many and why (`"3 candidates weren't scored: embeddings timed out after 3 tries"`); the call is a tool error with the reason only when the question or every candidate can't be embedded. Papers that `search` and `find_candidates` return (and the seeds) are embedded in the background as soon as they're found, so `score_candidates` mostly reads stored vectors; it waits up to 60 s for a warm-up still embedding its papers rather than sending them again.
2. `rerank` reorders up to 100 candidates for the goal. Pass it the top of `score_candidates`, so the 100 it sees are the closest in meaning rather than the first found.

`rerank` has two backends, picked per call by `backend` or for the server by `RERANK_BACKEND` (default `super_vl`):

| Backend | Model | How | Reasons | Off-topic papers |
| --- | --- | --- | --- | --- |
| `super_vl` | Nemotron 3.5 Super VL on Token Factory | One listwise request with the seeds as context, reasoning off unless `RERANK_THINKING=1` | Yes | Left out |
| `rerank_vl` | Llama Nemotron Rerank VL 1B v2 on NVIDIA's hosted API | Scores each candidate's title and abstract against the goal alone; `score` is the logit through a sigmoid | Empty | Kept, ranked low |

Token Factory serves no rerank model, so `rerank_vl` needs `NVIDIA_API_KEY` from [build.nvidia.com](https://build.nvidia.com). Without the key, or if NVIDIA's API fails, the call is ranked by `super_vl` instead; `backend` in the result names the backend that actually ranked, and `skipped` says why it changed. Super VL takes about 30 seconds for 60 candidates, and its order, 0-to-1 `score` and `reason` are the model's judgement.

Concept.md's step 5 also adds citation overlap with the seeds, recency and a Lightning verdict per candidate to `score_candidates`; none of those exist yet, and Concept.md gives no weights for combining them (its `0.6 × cosine + 0.4 × citation overlap` is paper-to-paper similarity for clustering, not relevance).

## Sources

| Source | Used for | Key |
| --- | --- | --- |
| PubMed E-utilities | Keyword search, records with abstracts, similar/citing/reference links, PMC full text | None; `NCBI_API_KEY` raises the limit from 3 to 10 requests a second |
| PMC article pages | Figure image URLs | None |
| OpenAlex | Keyword search across fields, DOI lookups, papers citing the seeds, reference lists of papers without a PMID | `OPENALEX_API_KEY` (free); required since keyless use shares a tiny per-IP budget |
| Semantic Scholar | Recommendations from the seeds, steered away from excluded papers | Optional `SEMANTIC_SCHOLAR_API_KEY` |
| Tavily | Web search of PubMed, PMC, bioRxiv, medRxiv and arXiv, each hit resolved to a paper ID; Extract for arXiv and publisher full text | `TAVILY_API_KEY` |
| arXiv | Records for arXiv hits | None |
| Token Factory | Embeddings for `score_candidates` (`Qwen/Qwen3-Embedding-8B`; set `EMBED_BASE_URL`, `EMBED_MODEL`, `EMBED_API_KEY` for another endpoint and `EMBED_CONCURRENCY` for requests at once), `rerank` with Super VL, and cluster names with Lightning (`LIGHTNING_MODEL`) | `TF_API_KEY` |
| NVIDIA API | `rerank` with Rerank VL | `NVIDIA_API_KEY`, only for `RERANK_BACKEND=rerank_vl` or `backend: rerank_vl` |
