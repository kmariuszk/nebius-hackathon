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
| `resolve_seed` | `doi`, `pmid` or `title` | full paper record |
| `get_paper` | `paper_id` | full paper record |

Paper IDs look like `doi:10.1038/s41586-021-03704-y`, `pmid:34290406`, `pmcid:PMC9187974` or `arxiv:2401.01234`. `score_candidates` ranks by embedding similarity only: the mean of the cosine similarity to the question and to the closest seed, or the question's alone without seeds. Citation overlap, recency, Lightning verdicts, rerank, clustering, full text and figures from `docs/Concept.md` are still to come.

## Sources

| Source | Used for | Key |
| --- | --- | --- |
| PubMed E-utilities | Keyword search, records with abstracts, similar/citing/reference links | None; `NCBI_API_KEY` raises the limit from 3 to 10 requests a second |
| OpenAlex | Keyword search across fields, DOI lookups, papers citing the seeds | `OPENALEX_API_KEY` (free); required since keyless use shares a tiny per-IP budget |
| Semantic Scholar | Recommendations from the seeds, steered away from excluded papers | Optional `SEMANTIC_SCHOLAR_API_KEY` |
| Tavily | Web search of PubMed, PMC, bioRxiv, medRxiv and arXiv; each hit is resolved to a paper ID | `TAVILY_API_KEY` |
| arXiv | Records for arXiv hits | None |
| Token Factory | Embeddings for `score_candidates` (`Qwen/Qwen3-Embedding-8B`; set `EMBED_BASE_URL`, `EMBED_MODEL`, `EMBED_API_KEY` for another endpoint) | `TF_API_KEY` |
