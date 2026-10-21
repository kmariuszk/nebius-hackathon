"""A Token Factory call that never answers ends after its three tries, against a local stub."""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from google.adk.models.lite_llm import LiteLlm
from google.adk.models.llm_request import LlmRequest
from google.genai import types

from harness import models

LIGHTNING_TIMEOUT = 0.2
SUPER_VL_TIMEOUT = 0.4
SLACK = 0.5


class HangingServer(ThreadingHTTPServer):
    """Accepts each request, records its model and when the first came, and never answers."""

    daemon_threads = True

    def __init__(self) -> None:
        self.models: list[str] = []
        self.first_at: float | None = None
        self.released = threading.Event()
        super().__init__(("127.0.0.1", 0), Hang)


class Hang(BaseHTTPRequestHandler):
    server: HangingServer

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.models.append(body["model"])
        self.server.first_at = self.server.first_at or time.monotonic()
        self.server.released.wait()

    def log_message(self, *args: object) -> None:
        pass


@pytest.fixture
def hanging(monkeypatch: pytest.MonkeyPatch) -> Iterator[HangingServer]:
    server = HangingServer()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("TF_BASE_URL", f"http://127.0.0.1:{server.server_address[1]}/v1")
    monkeypatch.setenv("MODEL_TIMEOUT", str(SUPER_VL_TIMEOUT))
    monkeypatch.setattr(models, "LIGHTNING_TIMEOUT", LIGHTNING_TIMEOUT)
    yield server
    server.released.set()
    server.shutdown()


async def hung_call(llm: LiteLlm, server: HangingServer) -> float:
    """Seconds from the first request to the call's failure; LiteLLM's first import comes before it."""
    request = LlmRequest(contents=[types.Content(role="user", parts=[types.Part(text="hi")])])
    with pytest.raises(Exception):
        async for _ in llm.generate_content_async(request):
            pass
    assert server.first_at is not None
    return time.monotonic() - server.first_at


async def test_hung_lightning_call_tries_lightning_twice_then_super_vl(hanging):
    took = await hung_call(models.lightning(), hanging)
    assert hanging.models == [models.LIGHTNING, models.LIGHTNING, models.SUPER_VL]
    assert took < 2 * LIGHTNING_TIMEOUT + SUPER_VL_TIMEOUT + SLACK


async def test_hung_super_vl_call_tries_super_vl_three_times(hanging):
    took = await hung_call(models.super_vl(), hanging)
    assert hanging.models == [models.SUPER_VL] * 3
    assert took < 3 * SUPER_VL_TIMEOUT + SLACK
