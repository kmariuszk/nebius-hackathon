"""`process_papers`: the reader and context passes for each placed paper, in the background.

The master places papers, calls `process_papers` and carries on; the cards
fill in while it ranks and answers (docs/Concept.md, Agent design,
`read_then_relate`). First model-free steps link the board's papers that cite
each other (kind `cites`, once a turn) and each paper to the paper it was
placed near (kind `similar`). Then, per paper, each step has its own runner:

1. the reader agent reads the paper on its own and answers with its artifacts as JSON;
2. a model-free step writes them to the card: each quote and highlight that is
   word for word in the abstract with `add_quote`, the summary and what
   couldn't be checked with `set_card`, then the first figure the reader
   picked that `get_figures` has an image for;
3. the context agent relates the paper to the board: "why it matters", the
   glance steps and links to the closest papers; when it saved no "why", it
   tries once more with the errors it got;
4. the "Agent is reading…" badge goes off, also when a step failed or the
   context agent left "why it matters" or the glance out, which the card's
   `gaps` then says. Every failed tool call is logged at WARNING.

At the end of the master's turn, a last model-free step groups the board's
papers into clusters with `apply_clusters`, once a chat, when the board has
6 papers or more and no clusters yet.

At most `PAPERS_AT_ONCE` papers are read at a time, and the background
agents make at most `CALLS_PER_MINUTE` model calls a minute, since Token
Factory's limit (60 a minute to start with) is shared with the chat and the
papers MCP. Every write carries the run ID of the turn that placed the paper
and the researcher's bearer, so it is attributed like the turn's own writes.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from functools import partial
from typing import Any

from google.adk.agents import BaseAgent, LlmAgent
from google.adk.agents.callback_context import CallbackContext
from google.adk.agents.invocation_context import InvocationContext
from google.adk.agents.readonly_context import ReadonlyContext
from google.adk.events import Event
from google.adk.models.llm_request import LlmRequest
from google.adk.runners import InMemoryRunner
from google.adk.tools import BaseTool, FunctionTool, ToolContext
from google.adk.tools.base_toolset import BaseToolset
from google.genai import types
from pydantic import Field

from harness.agents.master import candidates
from harness.board.tools import BoardTools

log = logging.getLogger(__name__)

PAPERS_AT_ONCE = 4
CALLS_PER_MINUTE = 40
# Passages the reader found that are tried as quotes; only abstract sentences pass.
QUOTES_TRIED = 8
# Seconds a closing chat gives its open passes to clear their badges.
CLOSE_SECONDS = 2.0
APP = "background"
ABSTRACT_ONLY = "Read from the abstract only: no full text was available."
# citation_links takes at most 200 papers, link_papers 100 links a call.
CITED_PAPERS = 200
LINKS_PER_CALL = 100
# A board is clustered once it has this many papers (D04).
CLUSTERED_PAPERS = 6


class Pace:
    """At most `per_minute` model calls in any minute, for every background agent in this process."""

    def __init__(self, per_minute: int) -> None:
        self.per_minute = per_minute
        self.calls: deque[float] = deque()

    async def before_model(self, callback_context: CallbackContext, llm_request: LlmRequest) -> None:
        while True:
            now = time.monotonic()
            while self.calls and now - self.calls[0] >= 60:
                self.calls.popleft()
            if len(self.calls) < self.per_minute:
                self.calls.append(now)
                return None
            await asyncio.sleep(60 - (now - self.calls[0]))


PACE = Pace(CALLS_PER_MINUTE)


class ToolFailed(RuntimeError):
    """A tool call from a model-free step came back as an error."""


class Calls:
    """MCP tools called from Python inside an agent's run, so they carry that run's headers.

    A call that fails is logged with the paper it was for and raises `ToolFailed`.
    """

    def __init__(self, tools: dict[str, BaseTool], tool_context: ToolContext, paper_id: str = "") -> None:
        self.tools = tools
        self.tool_context = tool_context
        self.paper_id = paper_id

    async def __call__(self, name: str, **args: Any) -> dict[str, Any]:
        if name in self.tools:
            result = await self.tools[name].run_async(args=args, tool_context=self.tool_context)
        else:
            result = {"error": "not offered by the MCP server"}
        if failed(result):
            error = error_text(result)
            log.warning("background %s %s %s: %s", self.paper_id, self.tool_context.agent_name, name, error)
            raise ToolFailed(f"{name}: {error}")
        return candidates.structured(result)


class Step(BaseAgent):
    """A model-free step: runs `action` with the tools of `tools`, under its own name for X-Model."""

    tools: list[BaseToolset] = Field(default_factory=list)
    action: Callable[[Calls], Awaitable[None]]
    paper_id: str = ""  # for the log

    async def _run_async_impl(self, ctx: InvocationContext):  # type: ignore[override]
        found: dict[str, BaseTool] = {}
        for toolset in self.tools:
            found.update({tool.name: tool for tool in await toolset.get_tools(ReadonlyContext(ctx))})
        await self.action(Calls(found, ToolContext(ctx), self.paper_id))
        return
        yield  # an async generator that yields no events


@dataclass(frozen=True)
class Job:
    paper_id: str
    run_id: str | None
    question: str


class ProcessPapers(BaseToolset):
    """The master's `process_papers` tool and the background passes it starts.

    Runner.close() closes the master's toolsets when the chat ends, which
    cancels the passes still running; each then clears its badge.
    """

    def __init__(
        self,
        board: BoardTools,
        reader: Callable[[], LlmAgent],
        context: Callable[[BoardTools], LlmAgent],
        pace: Pace = PACE,
    ) -> None:
        super().__init__()
        self.board = board
        self.reader = reader
        self.context = context
        self.pace = pace
        self.slots = asyncio.Semaphore(PAPERS_AT_ONCE)
        self.started: set[str] = set()
        self.tasks: set[asyncio.Task[None]] = set()
        self.citing: dict[str, asyncio.Task[None]] = {}  # each turn's citation step, by run ID
        self.cited: set[str] = set()
        self.clustered = False  # the board has clusters, or this chat clustered it
        self.clustering: asyncio.Task[None] | None = None
        self.tool = FunctionTool(self.process_papers)

    async def get_tools(self, readonly_context: ReadonlyContext | None = None) -> list[BaseTool]:
        return [self.tool]

    async def process_papers(self, paper_ids: list[str], tool_context: ToolContext) -> dict[str, Any]:
        """Read placed papers in the background and fill in their cards; returns at once.

        Each paper is first linked to the paper you placed it near. Then the reader agent reads
        its full text (or abstract), its summary and quotes go onto the card, and the context
        agent writes why it matters for the board's question, the paper at a glance, and links
        to the closest papers. The "Agent is reading…" badge stays on until the card is filled
        in. Don't wait for it.

        Args:
            paper_ids: Papers you placed with add_papers in this chat, or [] for every one
                you placed that isn't being read yet. Seeds are not read.
        """
        state = tool_context.state.to_dict()
        cards = candidates.placed(state)
        wanted = list(dict.fromkeys(paper_ids or [p for p, kind in cards.items() if kind != "seed"]))
        result = {
            "started": [p for p in wanted if p in cards and p not in self.started],
            "alreadyStarted": [p for p in wanted if p in self.started],
            "notPlaced": [p for p in wanted if p not in cards],
        }
        self.start(result["started"], state)
        return result

    async def after_turn(self, callback_context: CallbackContext) -> None:
        """After the master's turn: read every suggestion it placed and didn't hand to `process_papers`,
        so no card keeps its badge on with nobody reading it."""
        state = callback_context.state.to_dict()
        left = [p for p, kind in candidates.placed(state).items() if kind != "seed" and p not in self.started]
        if left:
            log.info("the master placed %d papers without reading them; reading them now", len(left))
            self.start(left, state)
        # New cards start with the badge on, and seeds aren't read: turn theirs off.
        seeds = [p for p, kind in candidates.placed(state).items() if kind == "seed" and p not in self.started]
        if seeds:
            self.started.update(seeds)
            job = Job(seeds[0], state.get("run_id"), "")
            task = asyncio.create_task(self.step("process_papers", job, lambda call: call(
                "mark_working", paperIds=seeds, on=False)))
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)
            # 1. Seeds start no batch, so a turn that placed only seeds links citations here too (once a turn).
            cite = asyncio.create_task(self.link_citations(job, seeds))
            self.tasks.add(cite)
            cite.add_done_callback(self.tasks.discard)
        # 4. Clusters, once per board, now that rank_papers has written the fits (D04).
        if self.board.canvas_url and not self.clustered and (self.clustering is None or self.clustering.done()):
            self.clustering = task = asyncio.create_task(self.cluster(Job("", state.get("run_id"), "")))
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)
        return None

    def start(self, paper_ids: list[str], state: dict[str, Any]) -> None:
        """The after-placement steps for these papers, in the background. A paper starts once a chat,
        so the link to the paper it was placed near is written once too."""
        if not paper_ids:
            return
        self.started.update(paper_ids)
        near = candidates.near(state)
        links = [{"from": p, "to": near[p], "kind": "similar"} for p in paper_ids if near.get(p, p) != p]
        jobs = [Job(p, state.get("run_id"), state.get(candidates.QUESTION, "")) for p in paper_ids]
        task = asyncio.create_task(self.batch(jobs, links))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def batch(self, jobs: list[Job], links: list[dict[str, str]]) -> None:
        # The after-placement steps (docs/wps/agent-harness/README.md), each one even if the one
        # before failed. Badges on first: cards already on the board don't have one yet.
        await self.try_step("turn the reading badges on", jobs[0], lambda call: call(
            "mark_working", paperIds=[job.paper_id for job in jobs], on=True))
        # 1. Citation links among the board's papers, once a turn (D03).
        await self.link_citations(jobs[0], [job.paper_id for job in jobs])
        # 2. Near links: each paper to the one it was placed near, without a model.
        if links:
            await self.try_step("link the papers to the ones they were placed near", jobs[0], lambda call: call(
                "link_papers", links=links))
        # 3. Reading.
        await asyncio.gather(*(self.read_then_relate(job) for job in jobs))

    async def link_citations(self, job: Job, paper_ids: list[str]) -> None:
        """Step 1, once a turn: a `cites` link for every citation between two papers on the board.

        A later batch of the same turn waits for the step already running, so citations go before its
        near links, and runs it again when that step didn't cover `paper_ids`.
        """
        if job.run_id is None:  # no turns to tell apart (adk web): every batch links
            return await self.cite(job)
        while True:
            task = self.citing.get(job.run_id)
            if task is not None and not task.done():
                await asyncio.shield(task)  # one waiter cancelled doesn't cancel it for the others
                continue
            if task is not None and self.cited.issuperset(paper_ids):
                return
            self.citing = {run_id: t for run_id, t in self.citing.items() if not t.done()}
            self.citing[job.run_id] = task = asyncio.create_task(self.cite(job))
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)
            await asyncio.shield(task)
            return

    async def cite(self, job: Job) -> None:
        """`citation_links` on every paper on the board, written with `link_papers`, without a model.
        Hidden while the papers MCP has no `citation_links`; a failure is only logged."""
        async def write(call: Calls) -> None:
            if "citation_links" not in call.tools:
                log.info("the papers MCP has no citation_links, so the board gets no citation links")
                return
            board = await call("get_board")
            on_board = [p["paperId"] for p in board.get("papers") or []]
            dropped = set(board.get("discardedIds") or [])
            paper_ids = [p for p in on_board if p not in dropped]
            if len(paper_ids) >= 2:
                found = await call("citation_links", paper_ids=paper_ids[:CITED_PAPERS])
                links = [{"from": link["from"], "to": link["to"], "kind": "cites", "source": link["source"]}
                         for link in found.get("links") or []]
                for start in range(0, len(links), LINKS_PER_CALL):
                    await call("link_papers", links=links[start : start + LINKS_PER_CALL])
                log.info("%d citations among the board's %d papers", len(links), len(paper_ids))
            self.cited.update(on_board)

        tools = [self.board.canvas("get_board", "link_papers"), self.board.papers("citation_links")]
        try:
            await self.run(Step(name="citations", tools=tools, action=write, paper_id=job.paper_id), "", job)
        except Exception as error:
            log.warning("could not link the papers that cite each other: %s", error)

    async def cluster(self, job: Job) -> None:
        """Step 4: `apply_clusters` on every paper on the board, without a model, once the board has
        `CLUSTERED_PAPERS` papers, unless it has clusters already (the agent's or a person's). Hidden
        while the canvas has no `apply_clusters`; a failure is only logged, and tried again next turn."""
        async def apply(call: Calls) -> None:
            if "apply_clusters" not in call.tools:
                log.info("the canvas has no apply_clusters (no cluster_papers in the papers MCP), so no clusters")
                return
            board = await call("get_board")
            if board.get("clusters"):
                self.clustered = True  # later papers go into them by `near`
                return
            if len(board.get("papers") or []) < CLUSTERED_PAPERS:
                return
            found = await call("apply_clusters")  # no paperIds: every paper, people's stay put
            self.clustered = True
            log.info("%d clusters on the board; %d papers or clusters skipped",
                     len(found.get("clusters") or []), len(found.get("skipped") or []))

        step = Step(name="clusters", tools=[self.board.canvas("get_board", "apply_clusters")], action=apply)
        try:
            await self.run(step, "clusters", job)
        except Exception as error:
            log.warning("could not cluster the board's papers: %s", error)

    async def try_step(self, what: str, job: Job, action: Callable[[Calls], Awaitable[Any]]) -> None:
        """A model-free step whose failure is only logged."""
        try:
            await self.step("process_papers", job, action)
        except Exception as error:
            log.warning("could not %s: %s", what, error)

    async def read_then_relate(self, job: Job) -> None:
        gaps: list[str] = []  # the reader's, written to the card with its summary
        new: list[str] = []  # found since the reader's write; `finish` adds them
        try:
            async with self.slots:
                try:
                    reading = parse_reading(await self.ask(self.reader(), f"Paper ID: {job.paper_id}", job))
                    card = await self.write_reading(job, reading, gaps)
                except Exception as error:
                    log.warning("reading %s failed: %s", job.paper_id, error)
                    new.append(f"The agent couldn't read this paper: {short(error)}")
                    return
                new += await self.relate(job, relate_request(job, reading, card))
        except asyncio.CancelledError:
            new.append("The agent stopped reading this paper: the chat closed first.")
            raise
        finally:
            await self.finish(job, gaps, new)

    async def relate(self, job: Job, request: str) -> list[str]:
        """Run the context agent, once more if it saved no `oneLine`; the gaps for what it still didn't write."""
        tried: list[dict[str, Any]] = []
        for retry in (False, True):
            try:
                await self.ask(self.context(self.board), request + (retry_note(tried) if retry else ""), job, tried)
            except Exception as error:
                log.warning("relating %s to the board failed: %s", job.paper_id, error)
                tried.append({"tool": "", "ok": False, "error": short(error), "written": []})
            if "oneLine" in saved(tried):
                break
        errors = [t["error"] for t in tried if not t["ok"]]
        if "oneLine" not in saved(tried):
            reason = short(errors[-1]) if errors else "it gave no answer"
            return [f"The agent couldn't write why this paper matters: {reason}"]
        if "glance" not in saved(tried):
            return ["The agent couldn't draw the paper at a glance."]
        return []

    async def write_reading(self, job: Job, reading: dict[str, Any], gaps: list[str]) -> dict[str, Any]:
        """The reader's artifacts onto the card, with its first figure pick that has an image; returns
        the paper's title, abstract and card quotes."""
        card: dict[str, Any] = {"quotes": []}
        passages = [q.get("text") for q in reading.get("quotes") or []]
        passages += [h.get("text") for h in reading.get("highlights") or []]
        figures = reading.get("figures") or []
        picks = [str(f["figureId"]) for f in figures if isinstance(f, dict) and f.get("figureId")]
        if reading.get("source") == "abstract":
            gaps.append(ABSTRACT_ONLY)

        async def write(call: Calls) -> None:
            paper = await call("get_paper", paper_id=job.paper_id)
            card.update(title=paper.get("title") or "", abstract=paper.get("abstract") or "")
            for text in list(dict.fromkeys(p for p in passages if isinstance(p, str) and p.strip()))[:QUOTES_TRIED]:
                try:
                    added = await call("add_quote", paperId=job.paper_id, text=text)
                except ToolFailed:
                    continue  # not in the abstract: the canvas only quotes the abstract so far
                if added.get("quoteId"):
                    card["quotes"].append({"id": added["quoteId"], "text": text})
            fields: dict[str, Any] = {}
            if summary := str(reading.get("summary") or "").strip():
                fields["summary"] = summary[:1500]
            if gaps:
                fields["gaps"] = gaps[:8]
            if fields:
                await call("set_card", paperId=job.paper_id, **fields)
            if picks:
                try:
                    if figure := card_figure(picks, await call("get_figures", paper_id=job.paper_id)):
                        await call("set_card", paperId=job.paper_id, figure=figure)
                except ToolFailed:
                    pass  # logged by `call`; a card without a figure is no gap

        await self.step("reader", job, write, papers=True)
        return card

    async def finish(self, job: Job, gaps: list[str], new: list[str]) -> None:
        """Badge off; first, when there are `new` gaps since the reader's write, the card's gaps become both."""
        async def done(call: Calls) -> None:
            if new:
                try:
                    await call("set_card", paperId=job.paper_id, gaps=[*gaps, *new][:8])
                except ToolFailed as error:
                    log.warning("could not note what went wrong on %s: %s", job.paper_id, error)
            await call("mark_working", paperIds=[job.paper_id], on=False)

        try:
            await self.step("process_papers", job, done)
        except Exception as error:
            log.error("could not clear the reading badge on %s: %s", job.paper_id, error)

    async def step(self, name: str, job: Job, action: Callable[[Calls], Awaitable[None]], papers: bool = False) -> None:
        tools = [self.board.canvas("get_board", "add_quote", "set_card", "mark_working", "link_papers")]
        if papers:
            tools.append(self.board.papers("get_paper", "get_figures"))
        await self.run(Step(name=name, tools=tools, action=action, paper_id=job.paper_id), "", job)

    async def ask(self, agent: LlmAgent, text: str, job: Job, tried: list[dict[str, Any]] | None = None) -> str:
        """Run a background agent on `text`; its final answer. Its tool calls go into `tried`, failures to the log."""
        agent.before_model_callback = self.pace.before_model
        agent.after_tool_callback = partial(recorded, job, [] if tried is None else tried)
        self.board.models.setdefault(agent.name, model_name(agent))
        return await self.run(agent, text, job)

    async def run(self, agent: BaseAgent, text: str, job: Job) -> str:
        runner = InMemoryRunner(agent=agent, app_name=APP)
        answer = ""
        try:
            session = await runner.session_service.create_session(
                app_name=APP, user_id=self.board.member_id or "local",
                state={"run_id": job.run_id, "board_id": self.board.board_id},
            )
            message = types.Content(role="user", parts=[types.Part(text=text or job.paper_id)])
            async for event in runner.run_async(user_id=session.user_id, session_id=session.id, new_message=message):
                if event.error_message:
                    raise RuntimeError(event.error_message)
                if said := final_text(event):
                    answer = said
        finally:
            await runner.close()  # closes the run's MCP toolsets in this task
        return answer

    async def wait(self) -> None:
        """Until every pass started so far has finished (tests)."""
        while self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)

    async def close(self) -> None:
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.wait(tasks, timeout=CLOSE_SECONDS)


def final_text(event: Event) -> str:
    if not event.is_final_response() or not event.content:
        return ""
    return "".join(part.text for part in event.content.parts or [] if part.text and not part.thought)


def parse_reading(text: str) -> dict[str, Any]:
    """The reader's JSON answer, also when it is fenced or has a line around it."""
    start, end = text.find("{"), text.rfind("}")
    try:
        reading = json.loads(text[start : end + 1]) if 0 <= start < end else None
    except ValueError:
        reading = None
    if not isinstance(reading, dict):
        raise ValueError("the reader's answer wasn't the JSON it should be")
    return reading


def relate_request(job: Job, reading: dict[str, Any], card: dict[str, Any]) -> str:
    """The context agent's request: the paper, the question, the reader's findings and the card's quotes."""
    quotes = "\n".join(f"- {q['id']}: {q['text']}" for q in card["quotes"]) or "none yet"
    highlights = "\n".join(
        f"- ({h.get('category', '')}) {h.get('text', '')}" for h in reading.get("highlights") or [] if isinstance(h, dict)
    )
    return (
        f"Paper ID: {job.paper_id}\n"
        f"Title: {card.get('title', '')}\n"
        f"The researcher's question: {job.question or 'not given; take it from get_board'}\n\n"
        f"Abstract:\n{card.get('abstract') or 'none'}\n\n"
        f"Quotes on the card:\n{quotes}\n\n"
        f"What the reader found (source: {reading.get('source', 'unknown')}):\n"
        f"TL;DR: {reading.get('tldr', '')}\n"
        f"Summary: {reading.get('summary', '')}\n"
        f"Highlights:\n{highlights or 'none'}"
    )


def card_figure(picks: list[str], found: dict[str, Any]) -> dict[str, Any] | None:
    """`set_card`'s figure: the reader's first pick that `get_figures` has an image for, or None."""
    by_id = {f.get("figureId"): f for f in found.get("figures") or [] if isinstance(f, dict) and f.get("imageUrl")}
    figure = next((by_id[p] for p in picks if p in by_id), None)
    if figure is None:
        return None
    caption = str(figure.get("caption") or "")[:1500]
    return {"imageUrl": figure["imageUrl"], "label": str(figure.get("label") or "")[:40], "caption": caption,
            "captionByAi": False}


def recorded(
    job: Job,
    tried: list[dict[str, Any]],
    *,
    tool: BaseTool,
    args: dict[str, Any],
    tool_context: ToolContext,
    tool_response: Any,
) -> None:
    """After a background agent's tool call: note it in `tried` with the card fields a
    `set_card` wrote, and log it when it failed."""
    ok = not failed(tool_response)
    error = "" if ok else error_text(tool_response)
    if not ok:
        log.warning("background %s %s %s: %s", job.paper_id, tool_context.agent_name, tool.name, error)
    written = candidates.structured(tool_response).get("written") if ok and tool.name == "set_card" else None
    tried.append({"tool": tool.name, "ok": ok, "error": error, "written": written or []})


def saved(tried: list[dict[str, Any]]) -> set[str]:
    """The card fields the context agent's `set_card` calls wrote."""
    return {field for t in tried for field in t["written"]}


def retry_note(tried: list[dict[str, Any]]) -> str:
    """What the context agent's second try adds to its request."""
    errors = "; ".join([short(t["error"]) for t in tried if not t["ok"]][-3:])
    errors = errors or ("none, but no set_card call wrote oneLine" if tried else "you called no tool")
    return (
        f"\n\nYour last attempt didn't save. Errors: {errors}. Call set_card with paperId and oneLine first, "
        "then claims and glance in a second call."
    )


def failed(result: Any) -> bool:
    return not isinstance(result, dict) or bool(result.get("isError")) or "error" in result


def error_text(result: Any) -> str:
    if isinstance(result, dict):
        if "error" in result:
            return str(result["error"])
        texts = [c.get("text", "") for c in result.get("content") or [] if isinstance(c, dict)]
        if any(texts):
            return " ".join(texts)
    return json.dumps(result, default=str)[:300]


def short(error: object) -> str:
    text = " ".join(str(error).split()) or type(error).__name__
    return text if len(text) <= 160 else text[:159] + "…"


def model_name(agent: LlmAgent) -> str:
    model = agent.model if isinstance(agent.model, str) else getattr(agent.model, "model", "")
    return model.removeprefix("openai/")
