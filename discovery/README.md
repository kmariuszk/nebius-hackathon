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
| `rerank` | `goal`, `paper_ids` (up to 100), `seed_ids`, `exclude_ids`, `k` | `ranked` (summary, `rank`, `score`, `reason`), `model`, `seconds`, `candidates`, `skipped` |
| `resolve_seed` | `doi`, `pmid` or `title` | full paper record |
| `get_paper` | `paper_id` | full paper record |

Paper IDs look like `doi:10.1038/s41586-021-03704-y`, `pmid:34290406`, `pmcid:PMC9187974` or `arxiv:2401.01234`. Clustering, full text and figures from `docs/Concept.md` are still to come.

### How ranking works today

Two steps, cheap then expensive:

1. `score_candidates` embeds every candidate's and seed's title and abstract with Qwen3-Embedding-8B on Token Factory (it serves no Nemotron embedder) and scores each candidate by the mean of its cosine similarity to the question and to the closest seed, or the question's alone without seeds. It handles hundreds of candidates in a few seconds, and in well under a second once their vectors are stored. The score is a formula, so it can be broken down into its two similarities.
2. `rerank` sends one listwise request to Nemotron 3.5 Super VL on Token Factory with the goal and up to 100 candidates' and seeds' titles and abstracts, and takes about 30 seconds for 60 candidates. Its order, 0-to-1 `score` and `reason` are the model's judgement. Pass it the top of `score_candidates`, so the 100 it sees are the closest in meaning rather than the first found.

Concept.md's step 5 also adds citation overlap with the seeds, recency and a Lightning verdict per candidate to `score_candidates`; none of those exist yet, and Concept.md gives no weights for combining them (its `0.6 × cosine + 0.4 × citation overlap` is paper-to-paper similarity for clustering, not relevance).

## Sources

| Source | Used for | Key |
| --- | --- | --- |
| PubMed E-utilities | Keyword search, records with abstracts, similar/citing/reference links | None; `NCBI_API_KEY` raises the limit from 3 to 10 requests a second |
| OpenAlex | Keyword search across fields, DOI lookups, papers citing the seeds | `OPENALEX_API_KEY` (free); required since keyless use shares a tiny per-IP budget |
| Semantic Scholar | Recommendations from the seeds, steered away from excluded papers | Optional `SEMANTIC_SCHOLAR_API_KEY` |
| Tavily | Web search of PubMed, PMC, bioRxiv, medRxiv and arXiv; each hit is resolved to a paper ID | `TAVILY_API_KEY` |
| arXiv | Records for arXiv hits | None |
| Token Factory | Embeddings for `score_candidates` (`Qwen/Qwen3-Embedding-8B`; set `EMBED_BASE_URL`, `EMBED_MODEL`, `EMBED_API_KEY` for another endpoint) and `rerank` with Super VL | `TF_API_KEY` |
