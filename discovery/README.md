# discovery

The papers MCP: the paper tools every agent uses, served over streamable HTTP. Papers found by any tool are cached in SQLite and deduplicated by DOI, PMID, PMCID, arXiv, OpenAlex and Semantic Scholar IDs.

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
| `rerank` | `goal`, `paper_ids` (up to 100), `seed_ids`, `exclude_ids`, `k`, `backend` (super_vl, rerank_vl) | `ranked` (summary, `rank`, `score`, `reason`), `backend`, `model`, `seconds`, `candidates`, `skipped` |
| `resolve_seed` | `doi`, `pmid` or `title` | full paper record |
| `get_paper` | `paper_id` | full paper record |
| `get_fulltext` | `paper_id`, `max_chars` (40,000) | `source` (pmc, web, abstract), `url`, `sections` (`title`, `text`), `figures` (`figureId`, `label`, `caption`), `truncated`, `omittedSections`, `skipped` |
| `check_quotes` | `paper_id`, `quotes` | each quote with `verbatim`, `section` and a `link` that highlights it (`#:~:text=`) |

Paper IDs look like `doi:10.1038/s41586-021-03704-y`, `pmid:34290406`, `pmcid:PMC9187974` or `arxiv:2401.01234`. Scoring, clustering and figure images from `docs/Concept.md` are still to come.

### Where full text comes from

`get_fulltext` tries, in order: PMC's JATS XML through E-utilities (`efetch db=pmc`, which also serves author manuscripts), arXiv's HTML page through Tavily Extract, then the open-access PDF or the DOI landing page through Tavily Extract. A page under 3,000 characters is treated as a landing page or paywall. When nothing works it returns the abstract with `source: "abstract"`, and `skipped` says why. Full text is cached in SQLite, so `check_quotes` checks against every section, including the ones `max_chars` cut. Back matter (acknowledgements, funding, author contributions and so on) is dropped, Methods sections go last, and no section takes more than a sixth of the budget. Figures (label and caption, no image yet) come from PMC only.

### How ranking works today

`rerank` is the only ranking step. It sends one listwise request to Nemotron 3.5 Super VL on Token Factory with the goal and every candidate's and seed's title and abstract, and takes about 30 seconds for 60 candidates. The order, the 0-to-1 `score` and the `reason` are the model's judgement. No formula is behind them, so a score can't be broken down into parts, and only the first 100 candidates get ranked.

`rerank` has two backends, picked per call by `backend` or for the server by `RERANK_BACKEND` (default `super_vl`):

| Backend | Model | How | Reasons | Off-topic papers |
| --- | --- | --- | --- | --- |
| `super_vl` | Nemotron 3.5 Super VL on Token Factory | One listwise request with the seeds as context | Yes | Left out |
| `rerank_vl` | Llama Nemotron Rerank VL 1B v2 on NVIDIA's hosted API | Scores each candidate's title and abstract against the goal alone; `score` is the logit through a sigmoid | Empty | Kept, ranked low |

Token Factory serves no rerank model, so `rerank_vl` needs `NVIDIA_API_KEY` from [build.nvidia.com](https://build.nvidia.com). Without the key, or if NVIDIA's API fails, the call is ranked by `super_vl` instead; `backend` in the result names the backend that actually ranked, and `skipped` says why it changed.

Concept.md's ranking pipeline puts a numeric score before this step: `score_candidates` (step 5) combines embedding similarity to the question and the seeds, citation overlap with the seeds and recency, then adds a Lightning verdict per candidate. `rerank` would then reorder only the top 100 by that score. None of step 5 exists yet. It needs an embedding model on Token Factory, a store for the vectors, and reference lists for every candidate, plus weights for the parts, which Concept.md doesn't give (its `0.6 × cosine + 0.4 × citation overlap` is paper-to-paper similarity for clustering, not relevance).

## Sources

| Source | Used for | Key |
| --- | --- | --- |
| PubMed E-utilities | Keyword search, records with abstracts, similar/citing/reference links, PMC full text | None; `NCBI_API_KEY` raises the limit from 3 to 10 requests a second |
| OpenAlex | Keyword search across fields, DOI lookups, papers citing the seeds | `OPENALEX_API_KEY` (free); required since keyless use shares a tiny per-IP budget |
| Semantic Scholar | Recommendations from the seeds, steered away from excluded papers | Optional `SEMANTIC_SCHOLAR_API_KEY` |
| Tavily | Web search of PubMed, PMC, bioRxiv, medRxiv and arXiv, each hit resolved to a paper ID; Extract for arXiv and publisher full text | `TAVILY_API_KEY` |
| arXiv | Records for arXiv hits | None |
| Token Factory | `rerank` with Super VL | `TF_API_KEY` |
| NVIDIA API | `rerank` with Rerank VL | `NVIDIA_API_KEY`, only for `RERANK_BACKEND=rerank_vl` or `backend: rerank_vl` |
