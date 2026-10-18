"""The papers MCP: the paper tools every agent uses (docs/Concept.md, Papers MCP tools).

Scoring, clustering, full text and figures are still to come; the tools here
are the ones the search and master agents need.
"""

from __future__ import annotations

from typing import Any

from mcp.server import MCPServer

from discovery.service import SEARCH_SOURCES, SEED_STRATEGIES, Discovery, SearchSource, Strategy

INSTRUCTIONS = """\
Tools for finding biomedical and computational research papers. Papers are identified by prefixed IDs \
such as doi:10.1038/s41586-021-03704-y, pmid:34290406, pmcid:PMC9187974 or arxiv:2401.01234. \
Use `search` for a query, `find_candidates` to expand from seed papers, `rerank` to rank candidates for a goal, \
and `get_paper` for a full record.
"""


def build_server(discovery: Discovery) -> MCPServer:
    server = MCPServer(name="papers", instructions=INSTRUCTIONS)

    @server.tool()
    async def search(
        query: str,
        limit: int = 20,
        sources: list[SearchSource] | None = None,
        since: str | None = None,
    ) -> dict[str, Any]:
        """Search for papers matching a query.

        Args:
            query: Keywords or a short natural-language query.
            limit: Most papers to return.
            sources: Any of pubmed (keyword search), openalex (keyword search across
                fields) and web (Tavily search of PubMed, PMC, bioRxiv, medRxiv, arXiv).
                Defaults to all three.
            since: Only papers published on or after this date, YYYY-MM-DD.

        Returns papers (ID, title, year, venue, authors, link, abstract excerpt,
        foundBy), the hit count per source, and the sources that were skipped and why.
        """
        return await discovery.search(query, limit, sources or SEARCH_SOURCES, since)

    @server.tool()
    async def find_candidates(
        seed_ids: list[str],
        exclude_ids: list[str] | None = None,
        strategies: list[Strategy] | None = None,
        since: str | None = None,
        limit: int = 100,
        query: str | None = None,
    ) -> dict[str, Any]:
        """Find candidate papers related to the seed papers.

        Args:
            seed_ids: Paper IDs of the researcher's seed papers.
            exclude_ids: Paper IDs never to return, such as discarded papers.
            strategies: Any of pubmed_links (PubMed similar, citing and reference
                links), citing (OpenAlex papers citing the seeds), recommend (Semantic
                Scholar recommendations), keyword and web (both need `query`).
                Defaults to pubmed_links, citing and recommend.
            since: Only papers published on or after this date, YYYY-MM-DD.
            limit: Most candidate IDs to return.
            query: The sub-query, for the keyword and web strategies.

        Returns candidate paper IDs (papers found by several strategies first), the
        count per strategy, and what was skipped and why. Seeds and excluded papers
        are never returned.
        """
        return await discovery.find_candidates(
            seed_ids, exclude_ids, strategies or SEED_STRATEGIES, since, limit, query
        )

    @server.tool()
    async def rerank(
        goal: str, paper_ids: list[str], seed_ids: list[str] | None = None, k: int = 20
    ) -> dict[str, Any]:
        """Rank candidate papers for the researcher's goal, best first, with a reason for each.

        Nemotron 3.5 Super VL reads every candidate's title and abstract, plus the
        seed papers', in one listwise pass. Takes about a minute for 100 candidates.

        Args:
            goal: The research question, in the researcher's words.
            paper_ids: Candidate paper IDs, up to 100; later ones are not ranked.
            seed_ids: The researcher's seed papers, used as context and never ranked.
            k: Most papers to return.

        Returns ranked (rank, paper summary, score from 0 to 1, reason), the model and
        seconds it took, how many candidates were ranked, and what was skipped and why.
        Off-topic candidates are left out, so ranked can be shorter than k.
        """
        return await discovery.rerank(goal, paper_ids, seed_ids, k)

    @server.tool()
    async def resolve_seed(
        doi: str | None = None, pmid: str | None = None, title: str | None = None
    ) -> dict[str, Any]:
        """Look up a seed paper by DOI, PMID or exact title, and return its full record."""
        return (await discovery.resolve_seed(doi, pmid, title)).to_record()

    @server.tool()
    async def get_paper(paper_id: str) -> dict[str, Any]:
        """The full record of one paper: IDs, title, authors, year, venue, abstract, links."""
        return (await discovery.get_paper(paper_id)).to_record()

    return server
