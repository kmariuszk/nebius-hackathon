"""A throwaway chat page for the master agent: `uv run python -m harness.chat`.

Serves http://127.0.0.1:8020 until the canvas has its own chat panel. Each
browser tab keeps one ADK session, so follow-ups ("drop the first one") work.
Every tool call, result, thought and reply streams to the page as one JSON
line, so you can watch the search agents and the rerank as they happen.
"""

from __future__ import annotations

import json
import os
import time
import traceback
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, StreamingResponse
from google.adk.runners import InMemoryRunner
from google.genai import types
from pydantic import BaseModel

from harness.agents.master import agent as master

APP_NAME = "chat"
USER_ID = "researcher"
PAGE = Path(__file__).with_name("chat.html")

app = FastAPI(title="Master agent chat")
runner = InMemoryRunner(agent=master.build(), app_name=APP_NAME)


class Message(BaseModel):
    text: str
    session_id: str | None = None


@app.get("/", response_class=HTMLResponse)
async def page() -> str:
    return PAGE.read_text()


@app.post("/chat")
async def chat(message: Message) -> StreamingResponse:
    return StreamingResponse(lines(message), media_type="application/x-ndjson")


async def lines(message: Message) -> AsyncIterator[str]:
    async for event in steps(message):
        yield json.dumps(event) + "\n"


async def steps(message: Message) -> AsyncIterator[dict[str, Any]]:
    session = None
    if message.session_id:
        session = await runner.session_service.get_session(
            app_name=APP_NAME, user_id=USER_ID, session_id=message.session_id
        )
    if session is None:
        session = await runner.session_service.create_session(app_name=APP_NAME, user_id=USER_ID)
    yield {"type": "session", "id": session.id}

    started = time.monotonic()
    content = types.Content(role="user", parts=[types.Part(text=message.text)])
    try:
        async for event in runner.run_async(
            user_id=USER_ID, session_id=session.id, new_message=content
        ):
            at = round(time.monotonic() - started, 1)
            for call in event.get_function_calls():
                yield {"type": "call", "at": at, "author": event.author, "name": call.name, "args": call.args}
            for response in event.get_function_responses():
                yield {"type": "result", "at": at, "name": response.name, "result": response.response}
            if event.content and event.content.parts:
                for part in event.content.parts:
                    if part.text and part.thought:
                        yield {"type": "thought", "at": at, "text": part.text}
                    elif part.text:
                        yield {"type": "text", "at": at, "text": part.text}
    except Exception as error:  # Show the failure in the page instead of a dead stream.
        traceback.print_exc()
        yield {"type": "error", "text": f"{type(error).__name__}: {error}"}
    yield {"type": "done", "at": round(time.monotonic() - started, 1)}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("CHAT_PORT", "8020")))
