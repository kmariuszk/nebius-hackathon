"""`process_papers`: the reader and context passes for each placed paper, in the background.

The master places papers, calls `process_papers` and carries on; the cards
fill in while it ranks and answers (docs/Concept.md, Agent design,
`read_then_relate`). Per paper, each step has its own runner:

1. the reader agent reads the paper on its own and answers with its artifacts as JSON;
2. a model-free step writes them to the card: each quote and highlight that is
   word for word in the abstract with `add_quote`, the summary and what
   couldn't be checked with `set_card`;
3. the context agent relates the paper to the board: "why it matters", the
   glance steps and links to the closest papers;
4. the "Agent is reading…" badge goes off, also when a step failed, which
   then says why in the card's `gaps`.

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

PAPERS_AT_ONCE = 3
CALLS_PER_MINUTE = 30
# Passages the reader found that are tried as quotes; only abstract sentences pass.
QUOTES_TRIED = 8
# Seconds a closing chat gives its open passes to clear their badges.
CLOSE_SECONDS = 2.0
APP = "background"
ABSTRACT_ONLY = "Read from the abstract only: no full text was available."


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
    """MCP tools called from Python inside an agent's run, so they carry that run's headers."""

    def __init__(self, tools: dict[str, BaseTool], tool_context: ToolContext) -> None:
        self.tools = tools
        self.tool_context = tool_context

    async def __call__(self, name: str, **args: Any) -> dict[str, Any]:
        if name not in self.tools:
            raise ToolFailed(f"{name}: not offered by the MCP server")
        result = await self.tools[name].run_async(args=args, tool_context=self.tool_context)
        if not isinstance(result, dict) or result.get("isError") or "error" in result:
            raise ToolFailed(f"{name}: {error_text(result)}")
        return candidates.structured(result)


class Step(BaseAgent):
    """A model-free step: runs `action` with the tools of `tools`, under its own name for X-Model."""

    tools: list[BaseToolset] = Field(default_factory=list)
    action: Callable[[Calls], Awaitable[None]]

    async def _run_async_impl(self, ctx: InvocationContext):  # type: ignore[override]
        found: dict[str, BaseTool] = {}
        for toolset in self.tools:
            found.update({tool.name: tool for tool in await toolset.get_tools(ReadonlyContext(ctx))})
        await self.action(Calls(found, ToolContext(ctx)))
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
        self.tool = FunctionTool(self.process_papers)

    async def get_tools(self, readonly_context: ReadonlyContext | None = None) -> list[BaseTool]:
        return [self.tool]

    async def process_papers(self, paper_ids: list[str], tool_context: ToolContext) -> dict[str, Any]:
        """Read placed papers in the background and fill in their cards; returns at once.

        For each paper the reader agent reads its full text (or abstract), its summary and
        quotes go onto the card, and the context agent writes why it matters for the board's
        question, the paper at a glance, and links to the closest papers. The "Agent is
        reading…" badge stays on until the card is filled in. Don't wait for it.

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
        self.start(result["started"], state.get("run_id"), state.get(candidates.QUESTION, ""))
        return result

    async def after_turn(self, callback_context: CallbackContext) -> None:
        """After the master's turn: read every suggestion it placed and didn't hand to `process_papers`,
        so no card keeps its badge on with nobody reading it."""
        state = callback_context.state.to_dict()
        left = [p for p, kind in candidates.placed(state).items() if kind != "seed" and p not in self.started]
        if left:
            log.info("the master placed %d papers without reading them; reading them now", len(left))
            self.start(left, state.get("run_id"), state.get(candidates.QUESTION, ""))
        return None

    def start(self, paper_ids: list[str], run_id: str | None, question: str) -> None:
        if not paper_ids:
            return
        self.started.update(paper_ids)
        task = asyncio.create_task(self.batch([Job(p, run_id, question) for p in paper_ids]))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def batch(self, jobs: list[Job]) -> None:
        # Badges on first (cards already on the board don't have one yet), then read.
        try:
            await self.step("process_papers", jobs[0], lambda call: call(
                "mark_working", paperIds=[job.paper_id for job in jobs], on=True))
        except Exception as error:
            log.warning("could not turn the reading badges on: %s", error)
        await asyncio.gather(*(self.read_then_relate(job) for job in jobs))

    async def read_then_relate(self, job: Job) -> None:
        gaps: list[str] = []
        written: list[str] = []
        try:
            async with self.slots:
                try:
                    reading = parse_reading(await self.ask(self.reader(), f"Paper ID: {job.paper_id}", job))
                    card = await self.write_reading(job, reading, gaps)
                    written = list(gaps)
                except Exception as error:
                    log.warning("reading %s failed: %s", job.paper_id, error)
                    gaps.append(f"The agent couldn't read this paper: {short(error)}")
                    return
                try:
                    await self.ask(self.context(self.board), relate_request(job, reading, card), job)
                except Exception as error:
                    log.warning("relating %s to the board failed: %s", job.paper_id, error)
                    gaps.append(f"The agent couldn't relate this paper to the board: {short(error)}")
        except asyncio.CancelledError:
            gaps.append("The agent stopped reading this paper: the chat closed first.")
            raise
        finally:
            await self.finish(job, gaps if gaps != written else None)

    async def write_reading(self, job: Job, reading: dict[str, Any], gaps: list[str]) -> dict[str, Any]:
        """The reader's artifacts onto the card; returns the paper's title, abstract and card quotes."""
        card: dict[str, Any] = {"quotes": []}
        passages = [q.get("text") for q in reading.get("quotes") or []]
        passages += [h.get("text") for h in reading.get("highlights") or []]
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

        await self.step("reader", job, write, papers=True)
        return card

    async def finish(self, job: Job, gaps: list[str] | None) -> None:
        async def done(call: Calls) -> None:
            if gaps:
                try:
                    await call("set_card", paperId=job.paper_id, gaps=gaps[:8])
                except ToolFailed as error:
                    log.warning("could not note what went wrong on %s: %s", job.paper_id, error)
            await call("mark_working", paperIds=[job.paper_id], on=False)

        try:
            await self.step("process_papers", job, done)
        except Exception as error:
            log.error("could not clear the reading badge on %s: %s", job.paper_id, error)

    async def step(self, name: str, job: Job, action: Callable[[Calls], Awaitable[None]], papers: bool = False) -> None:
        tools = [self.board.canvas("get_board", "add_quote", "set_card", "mark_working")]
        if papers:
            tools.append(self.board.papers("get_paper"))
        await self.run(Step(name=name, tools=tools, action=action), "", job)

    async def ask(self, agent: LlmAgent, text: str, job: Job) -> str:
        """Run a background agent on `text`; its final answer."""
        agent.before_model_callback = self.pace.before_model
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


def error_text(result: Any) -> str:
    if isinstance(result, dict):
        if "error" in result:
            return str(result["error"])
        texts = [c.get("text", "") for c in result.get("content") or [] if isinstance(c, dict)]
        if any(texts):
            return " ".join(texts)
    return json.dumps(result, default=str)[:300]


def short(error: Exception) -> str:
    text = " ".join(str(error).split()) or type(error).__name__
    return text if len(text) <= 160 else text[:159] + "…"


def model_name(agent: LlmAgent) -> str:
    model = agent.model if isinstance(agent.model, str) else getattr(agent.model, "model", "")
    return model.removeprefix("openai/")
