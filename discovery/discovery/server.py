"""The papers MCP: the paper tools every agent uses (docs/Concept.md, Papers MCP tools).

Scoring is embedding similarity only so far; verdicts are still to come.
The tools here are the ones the search, master and reader agents and the
board service need.
"""

from __future__ import annotations

from typing import Annotated, Any

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import AfterValidator, BeforeValidator

from discovery import citations, clusters
from discovery.fulltext import DEFAULT_MAX_CHARS
from discovery.service import (
    DATE,
    PLACEHOLDERS,
    SEARCH_SOURCES,
    SEED_STRATEGIES,
    SINCE_FORMAT,
    Discovery,
    RerankBackend,
    SearchSource,
    Strategy,
)
from discovery.sources import Skipped


def _unset(value: Any) -> Any:
    """A placeholder such as "None" for an optional argument means it was left out."""
    return None if isinstance(value, str) and value.strip() in PLACEHOLDERS else value


def _date(value: str | None) -> str | None:
    if value is not None and not DATE.match(value):
        raise ValueError(SINCE_FORMAT)
    return value


Since = Annotated[str | None, BeforeValidator(_unset), AfterValidator(_date)]
OptionalIds = Annotated[list[str] | None, BeforeValidator(_unset)]
OptionalText = Annotated[str | None, BeforeValidator(_unset)]

INSTRUCTIONS = """\
Tools for finding biomedical and computational research papers. Papers are identified by prefixed IDs \
such as doi:10.1038/s41586-021-03704-y, pmid:34290406, pmcid:PMC9187974 or arxiv:2401.01234. \
Use `search` for a query, `find_candidates` to expand from seed papers, `score_candidates` to rank \
candidates by embedding similarity, `rerank` to rank the best of them for a goal, \
`get_paper` for a full record, `get_fulltext` to read one paper and `check_quotes` to verify passages from it.
"""


def build_server(discovery: Discovery) -> MCPServer:
    server = MCPServer(name="papers", instructions=INSTRUCTIONS)

    @server.tool()
    async def search(
        query: str,
        limit: int = 20,
        sources: Annotated[list[SearchSource] | None, BeforeValidator(_unset)] = None,
        since: Since = None,
    ) -> dict[str, Any]:
        """Search for papers matching a query.

        Args:
            query: Keywords or a short natural-language query.
            limit: Most papers to return.
            sources: Any of pubmed (keyword search), openalex (keyword search across
                fields) and web (Tavily search of PubMed, PMC, bioRxiv, medRxiv, arXiv).
                Defaults to all three; leave out when not needed.
            since: Only papers published on or after this date: YYYY, YYYY-MM or
                YYYY-MM-DD. Leave out when not needed.

        Returns papers (ID, title, year, venue, authors, link, abstract excerpt,
        foundBy), the hit count per source, and the sources that were skipped and why.
        """
        return await discovery.search(query, limit, sources or SEARCH_SOURCES, since)

    @server.tool()
    async def find_candidates(
        seed_ids: list[str],
        exclude_ids: OptionalIds = None,
        strategies: Annotated[list[Strategy] | None, BeforeValidator(_unset)] = None,
        since: Since = None,
        limit: int = 100,
        query: OptionalText = None,
    ) -> dict[str, Any]:
        """Find candidate papers related to the seed papers.

        Args:
            seed_ids: Paper IDs of the researcher's seed papers.
            exclude_ids: Paper IDs never to return, such as discarded papers. Leave out
                when not needed.
            strategies: Any of pubmed_links (PubMed similar, citing and reference
                links), citing (OpenAlex papers citing the seeds), recommend (Semantic
                Scholar recommendations), keyword and web (both need `query`).
                Defaults to pubmed_links, citing and recommend; leave out when not needed.
            since: Only papers published on or after this date: YYYY, YYYY-MM or
                YYYY-MM-DD. Leave out when not needed.
            limit: Most candidate IDs to return.
            query: The sub-query, for the keyword and web strategies. Leave out when
                not needed.

        Returns candidate paper IDs (papers found by several strategies first), the
        count per strategy, and what was skipped and why. Seeds and excluded papers
        are never returned.
        """
        return await discovery.find_candidates(
            seed_ids, exclude_ids, strategies or SEED_STRATEGIES, since, limit, query
        )

    @server.tool()
    async def rerank(
        goal: str,
        paper_ids: list[str],
        seed_ids: OptionalIds = None,
        exclude_ids: OptionalIds = None,
        k: int = 20,
        backend: Annotated[RerankBackend | None, BeforeValidator(_unset)] = None,
    ) -> dict[str, Any]:
        """Rank candidate papers for the researcher's goal, best first, with a reason for each.

        The super_vl backend (the default): Nemotron 3.5 Super VL reads every
        candidate's title and abstract, plus the seed papers', in one listwise pass.
        Takes about a minute for 100 candidates. The rerank_vl backend: Llama Nemotron
        Rerank VL scores each candidate against the goal alone in a second or two, with
        no reasons, and falls back to super_vl if it cannot run.

        Args:
            goal: The research question, in the researcher's words.
            paper_ids: Candidate paper IDs, up to 100; later ones are not ranked.
            seed_ids: The researcher's seed papers, used as context and never ranked.
            exclude_ids: Papers the researcher dropped; never ranked, under any of their IDs.
            k: Most papers to return (at least 1).
            backend: super_vl or rerank_vl; defaults to the server's RERANK_BACKEND,
                else super_vl. Leave it unset unless asked to compare rerankers.

        Returns ranked (rank, paper summary, score from 0 to 1, reason), the backend and
        model that ranked them and the seconds it took, how many candidates were ranked,
        and what was skipped and why. super_vl leaves off-topic candidates out, so
        ranked can be shorter than k; rerank_vl's reasons are empty.
        """
        return await discovery.rerank(goal, paper_ids, seed_ids, exclude_ids, k, backend)

    @server.tool()
    async def score_candidates(
        question: str,
        candidate_ids: list[str],
        seed_ids: OptionalIds = None,
        limit: int = 20,
    ) -> dict[str, Any]:
        """Rank candidate papers by how close their title and abstract are in meaning to
        the research question and to the nearest seed paper.

        Args:
            question: The research question (not a sub-query).
            candidate_ids: Paper IDs to rank, such as the IDs from `search` and `find_candidates`.
            seed_ids: Paper IDs of the researcher's seed papers.
            limit: Most papers to return.

        Returns the top papers (ID, title, year, score from 0 to 1, similarity to the
        question and to the closest seed, which seed that is), how many candidates
        were scored, and the IDs that could not be found or embedded and why. Seeds
        are never returned as candidates.
        """
        try:
            return await discovery.score_candidates(question, candidate_ids, seed_ids, limit)
        except (ValueError, Skipped) as error:
            # A ToolError keeps its text; anything else reaches the model as "Error executing tool".
            raise ToolError(str(error)) from error

    @server.tool()
    async def citation_links(paper_ids: list[str]) -> dict[str, Any]:
        """Which of these papers cite which: PubMed's reference lists, and OpenAlex's for
        papers without a PMID.

        Args:
            paper_ids: 2 to 200 paper IDs, such as every paper on a board.

        Returns links ([{from, to, source}]: `from` cites `to`, both among paper_ids and
        under the IDs given; source is pubmed or openalex) and what was skipped and why.
        """
        try:
            return await citations.citation_links(discovery, paper_ids)
        except ValueError as error:
            raise ToolError(str(error)) from error

    @server.tool()
    async def cluster_papers(
        paper_ids: list[str], k: Annotated[int | None, BeforeValidator(_unset)] = None
    ) -> dict[str, Any]:
        """Group papers into clusters of similar papers by their embeddings, each named by Lightning.

        Args:
            paper_ids: 2 to 500 paper IDs, such as every paper on a board.
            k: How many clusters. Leave out to have one under 6 papers, else 2 to 6
                by the number of papers.

        Returns clusters ([{clusterId, paperIds, label}]: paperIds under the IDs given,
        the most central paper first; clusterId "c-" and that paper's ID, so it stays
        the same as papers are added; label null if it couldn't be named), similarities
        ([{a, b, similarity}]: each paper's 3 nearest neighbours by cosine similarity)
        and the papers that couldn't be loaded or embedded, and why.
        """
        try:
            return await clusters.cluster_papers(discovery, paper_ids, k)
        except (ValueError, Skipped) as error:
            raise ToolError(str(error)) from error

    @server.tool()
    async def resolve_seed(
        doi: OptionalText = None, pmid: OptionalText = None, title: OptionalText = None
    ) -> dict[str, Any]:
        """Look up a seed paper by DOI, PMID or exact title, and return its full record."""
        return (await discovery.resolve_seed(doi, pmid, title)).to_record()

    @server.tool()
    async def get_paper(paper_id: str) -> dict[str, Any]:
        """The full record of one paper: IDs, title, authors, year, venue, abstract, links."""
        return (await discovery.get_paper(paper_id)).to_record()

    @server.tool()
    async def get_fulltext(paper_id: str, max_chars: int = DEFAULT_MAX_CHARS) -> dict[str, Any]:
        """The paper's full text by section, and its figure captions, for reading one paper.

        Tries PMC, then arXiv's HTML page, then the open-access PDF or publisher page;
        when none has the paper, returns the abstract alone with source "abstract".

        Args:
            paper_id: The paper's ID.
            max_chars: Most characters of text to return. Methods sections come last,
                so they are the first to be cut.

        Returns source (pmc, web or abstract), the url the text came from, sections
        ([{title, text}]), figures ([{figureId, label, caption, imageUrl}]; PMC papers
        only), whether the text was truncated, the omitted section titles, and the
        sources that were skipped and why.
        """
        return await discovery.get_fulltext(paper_id, max_chars)

    @server.tool()
    async def get_figures(paper_id: str) -> dict[str, Any]:
        """The paper's figures with their image URLs, to show one on its card (PMC papers only).

        Returns source (pmc, web or abstract), figures ([{figureId, label, caption,
        imageUrl}]; imageUrl is null when PMC's article page had no image for it), and
        what was skipped and why.
        """
        return await discovery.get_figures(paper_id)

    @server.tool()
    async def check_quotes(paper_id: str, quotes: list[str]) -> dict[str, Any]:
        """Check that each passage appears word for word in the paper's full text.

        Spacing, quote marks, dashes and markdown emphasis are ignored; any other
        change, including an ellipsis, fails the check. Passages under 10 characters
        always fail.

        Returns each passage with verbatim (true or false), the section it was found
        in, and a link that opens the source page with the passage highlighted.
        """
        return await discovery.check_quotes(paper_id, quotes)

    return server
