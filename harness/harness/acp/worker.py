"""`SessionWorker`: one long-lived task per ACP session that owns the ADK runner and its MCP toolsets.

MCP sessions must be closed in the task that opened them, so the worker opens
the runner, runs the session's prompts one at a time and closes the runner
(and with it the toolsets) when the chat ends. `session/cancel` sets the
turn's abort signal (decision D9).
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from contextlib import aclosing
from dataclasses import dataclass, field
from typing import Any

from acp import update_agent_message_text
from acp.schema import StopReason
from google.adk.agents import LlmAgent
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.apps import App
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService

from harness.acp import prices
from harness.acp.images import ImagesPlugin
from harness.acp.mapping import EventMapper, accepts_images, to_genai_content
from harness.acp.trace import AcpTracePlugin
from harness.board.ids import new_run_id
from harness.board.tools import BoardTools

log = logging.getLogger(__name__)

APP = "board"
# SSE streams text and thoughts as they come; NONE gives whole messages if streaming
# with tool calls ever breaks through LiteLLM (T04 risks).
STREAMING = StreamingMode.SSE


@dataclass(eq=False)
class Job:
    blocks: list[Any]
    abort: asyncio.Event = field(default_factory=asyncio.Event)
    result: asyncio.Future[StopReason] = field(
        default_factory=lambda: asyncio.get_running_loop().create_future()
    )


class SessionWorker:
    """Runs one ACP session's prompts through an ADK runner it owns."""

    def __init__(self, send: Callable[[Any], Awaitable[None]], agent: LlmAgent, board: BoardTools) -> None:
        self.send = send
        self.agent = agent
        self.board = board
        self.model = board.models.get(agent.name, "")
        self.trace = AcpTracePlugin(send, board.models)
        self.images = ImagesPlugin(board.images, board.models)
        self.jobs: asyncio.Queue[Job | None] = asyncio.Queue()
        self.open: set[Job] = set()
        self.task = asyncio.create_task(self.run(), name=f"session-worker-{board.session_id}")

    async def prompt(self, blocks: list[Any]) -> StopReason:
        if self.task.done():
            raise RuntimeError("this chat's agent has stopped; start a new chat")
        job = Job(blocks)
        self.open.add(job)
        await self.jobs.put(job)
        try:
            return await job.result
        except asyncio.CancelledError:
            job.abort.set()  # the client went away mid-turn
            raise

    def cancel(self) -> None:
        for job in self.open:
            job.abort.set()

    async def close(self) -> None:
        self.cancel()
        await self.jobs.put(None)
        await self.task

    async def run(self) -> None:
        plugins = [self.trace, self.images]
        runner = Runner(app=App(name=APP, root_agent=self.agent, plugins=plugins), session_service=InMemorySessionService())
        try:
            session = await runner.session_service.create_session(
                app_name=APP, user_id=self.board.member_id or "local", state={"board_id": self.board.board_id}
            )
            while (job := await self.jobs.get()) is not None:
                stop = await self.run_prompt(runner, session.user_id, session.id, job)
                self.open.discard(job)
                if not job.result.done():
                    job.result.set_result(stop)
        except Exception as error:
            log.exception("session worker failed")
            for job in self.open:
                if not job.result.done():
                    job.result.set_exception(error)
        finally:
            for job in self.open:
                if not job.result.done():
                    job.result.set_result("cancelled")
            await runner.close()  # closes the MCP toolsets in the task that opened them

    async def run_prompt(self, runner: Runner, user_id: str, session_id: str, job: Job) -> StopReason:
        if job.abort.is_set():
            return "cancelled"
        mapper = EventMapper(prices.context_window(self.model), lambda: self.trace.cost)
        events = runner.run_async(
            user_id=user_id,
            session_id=session_id,
            new_message=to_genai_content(job.blocks, images=accepts_images(self.model)),
            state_delta={"run_id": new_run_id()},
            run_config=RunConfig(streaming_mode=STREAMING),
            abort_signal=job.abort,
        )
        try:
            async with aclosing(events):
                async for event in events:
                    if job.abort.is_set():
                        continue  # only ADK's abort bookkeeping is left
                    for update in mapper.updates(event):
                        await self.send(update)
        except Exception as error:
            if not job.abort.is_set():
                log.exception("prompt failed")
                await self.send(update_agent_message_text(f"Something went wrong: {error}"))
        finally:
            await self.trace.fail_open("cancelled" if job.abort.is_set() else "the turn ended first")
        await self.send(mapper.usage())
        return "cancelled" if job.abort.is_set() else "end_turn"
