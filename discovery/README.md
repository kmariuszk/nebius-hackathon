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
| `score_candidates` | `question`, `candidate_ids`, `seed_ids`, `limit` | `top` (ID, title, year, `score`, `questionSimilarity`, `seedSimilarity`, `closestSeed`), `scored`, `skipped` |
| `rerank` | `goal`, `paper_ids` (up to 100), `seed_ids`, `exclude_ids`, `k`, `backend` (super_vl, rerank_vl) | `ranked` (summary, `rank`, `score`, `reason`), `backend`, `model`, `seconds`, `candidates`, `skipped` |
| `resolve_seed` | `doi`, `pmid` or `title` | full paper record |
| `get_paper` | `paper_id` | full paper record |
| `get_fulltext` | `paper_id`, `max_chars` (40,000) | `source` (pmc, web, abstract), `url`, `sections` (`title`, `text`), `figures` (`figureId`, `label`, `caption`), `truncated`, `omittedSections`, `skipped` |
| `check_quotes` | `paper_id`, `quotes` | each quote with `verbatim`, `section` and a `link` that highlights it (`#:~:text=`) |

`since` takes `YYYY`, `YYYY-MM` or `YYYY-MM-DD` (a year or month counts from its first day); anything else is a tool error naming those formats. An optional argument sent as a placeholder (`"None"`, `"none"`, `"null"`, `"NULL"`, `"undefined"` or `""`) counts as left out.

Paper IDs look like `doi:10.1038/s41586-021-03704-y`, `pmid:34290406`, `pmcid:PMC9187974` or `arxiv:2401.01234`. Clustering and figure images from `docs/Concept.md` are still to come, and scoring is embedding similarity only so far.

### Where full text comes from

`get_fulltext` tries, in order: PMC's JATS XML through E-utilities (`efetch db=pmc`, which also serves author manuscripts), arXiv's HTML page through Tavily Extract, then the open-access PDF or the DOI landing page through Tavily Extract. A page under 3,000 characters is treated as a landing page or paywall. When nothing works it returns the abstract with `source: "abstract"`, and `skipped` says why. Full text is cached in SQLite, so `check_quotes` checks against every section, including the ones `max_chars` cut. Back matter (acknowledgements, funding, author contributions and so on) is dropped, Methods sections go last, and no section takes more than a sixth of the budget. Figures (label and caption, no image yet) come from PMC only.

### How ranking works today

Two steps, cheap then expensive:

1. `score_candidates` embeds every candidate's and seed's title and abstract with Qwen3-Embedding-8B on Token Factory (it serves no Nemotron embedder) and scores each candidate by the mean of its cosine similarity to the question and to the closest seed, or the question's alone without seeds. It handles hundreds of candidates in a few seconds, and in well under a second once their vectors are stored. The score is a formula, so it can be broken down into its two similarities.
2. `rerank` reorders up to 100 candidates for the goal. Pass it the top of `score_candidates`, so the 100 it sees are the closest in meaning rather than the first found.

`rerank` has two backends, picked per call by `backend` or for the server by `RERANK_BACKEND` (default `super_vl`):

| Backend | Model | How | Reasons | Off-topic papers |
| --- | --- | --- | --- | --- |
| `super_vl` | Nemotron 3.5 Super VL on Token Factory | One listwise request with the seeds as context | Yes | Left out |
| `rerank_vl` | Llama Nemotron Rerank VL 1B v2 on NVIDIA's hosted API | Scores each candidate's title and abstract against the goal alone; `score` is the logit through a sigmoid | Empty | Kept, ranked low |

Token Factory serves no rerank model, so `rerank_vl` needs `NVIDIA_API_KEY` from [build.nvidia.com](https://build.nvidia.com). Without the key, or if NVIDIA's API fails, the call is ranked by `super_vl` instead; `backend` in the result names the backend that actually ranked, and `skipped` says why it changed. Super VL takes about 30 seconds for 60 candidates, and its order, 0-to-1 `score` and `reason` are the model's judgement.

Concept.md's step 5 also adds citation overlap with the seeds, recency and a Lightning verdict per candidate to `score_candidates`; none of those exist yet, and Concept.md gives no weights for combining them (its `0.6 × cosine + 0.4 × citation overlap` is paper-to-paper similarity for clustering, not relevance).

## Sources

| Source | Used for | Key |
| --- | --- | --- |
| PubMed E-utilities | Keyword search, records with abstracts, similar/citing/reference links, PMC full text | None; `NCBI_API_KEY` raises the limit from 3 to 10 requests a second |
| OpenAlex | Keyword search across fields, DOI lookups, papers citing the seeds | `OPENALEX_API_KEY` (free); required since keyless use shares a tiny per-IP budget |
| Semantic Scholar | Recommendations from the seeds, steered away from excluded papers | Optional `SEMANTIC_SCHOLAR_API_KEY` |
| Tavily | Web search of PubMed, PMC, bioRxiv, medRxiv and arXiv, each hit resolved to a paper ID; Extract for arXiv and publisher full text | `TAVILY_API_KEY` |
| arXiv | Records for arXiv hits | None |
| Token Factory | Embeddings for `score_candidates` (`Qwen/Qwen3-Embedding-8B`; set `EMBED_BASE_URL`, `EMBED_MODEL`, `EMBED_API_KEY` for another endpoint) and `rerank` with Super VL | `TF_API_KEY` |
| NVIDIA API | `rerank` with Rerank VL | `NVIDIA_API_KEY`, only for `RERANK_BACKEND=rerank_vl` or `backend: rerank_vl` |
