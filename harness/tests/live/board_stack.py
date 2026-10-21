"""The real stack for the live board check: the papers MCP and the board service.

Both run as subprocesses on free ports with their data in a temp dir, each in
its own process group so teardown stops everything they started. The test
drives the harness itself (`fixtures.acp_client.harness`).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import pytest
from dotenv import dotenv_values

from fixtures.acp_client import HARNESS_DIR

REPO = HARNESS_DIR.parent
MEMBER = "m_livecheck0"
KEYS = ("TF_API_KEY", "TAVILY_API_KEY")
NODE_MIN = (22, 18)
READY_SECONDS = 30
LOG_LINES = 50
SUPER_VL = "nvidia/Nemotron-3.5-Super-VL"
# LIVE_MODEL=cheap: Lightning stands in for Super VL, at about a fifth of the price.
CHEAP_MODEL = "nvidia/Nemotron-3_5-Lightning"


def live_model() -> str | None:
    """The model that stands in for Super VL (`LIVE_MODEL`: "cheap" or a model ID), or None to keep it."""
    choice = os.environ.get("LIVE_MODEL", "").strip()
    return CHEAP_MODEL if choice == "cheap" else choice or None


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def child_env(**extra: str) -> dict[str, str]:
    """Our environment without the conftest's placeholder key and the harness venv, plus `extra`."""
    env = {k: v for k, v in os.environ.items() if k != "VIRTUAL_ENV"}
    if env.get("TF_API_KEY") == "test-key":
        del env["TF_API_KEY"]
    return {**env, **extra}


def missing_keys() -> list[str]:
    """The keys neither our environment nor the nearest `.env` (as `harness.settings` finds it) has."""
    env_file = next((d / ".env" for d in (HARNESS_DIR, *HARNESS_DIR.parents) if (d / ".env").is_file()), None)
    found = {**(dotenv_values(env_file) if env_file else {}), **child_env()}
    return [name for name in KEYS if not (found.get(name) or "").strip()]


def node_binary() -> tuple[str | None, str]:
    """The Node to run the board service with (`NODE`, else `node` on PATH), and why not if it's unfit."""
    node = os.environ.get("NODE") or shutil.which("node")
    if not node:
        return None, "Node 22.18 or later (none on PATH; set NODE=/path/to/node)"
    version = subprocess.run([node, "--version"], capture_output=True, text=True, check=False).stdout.strip()
    parts = tuple(int(n) for n in re.findall(r"\d+", version)[:2])
    if parts < NODE_MIN:
        return None, f"Node 22.18 or later (found {version or 'nothing'} at {node}; set NODE=/path/to/node)"
    return node, ""


def mcp_tools(url: str, member: str | None = None, timeout: float = 30) -> set[str]:
    """The tool names an MCP server lists, over plain JSON-RPC (both servers are stateless)."""
    headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
    if member:
        headers["Authorization"] = f"Bearer {member}"
    init = {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "live-check", "version": "0"}}
    with httpx.Client(headers=headers, timeout=timeout) as client:
        rpc(client, url, "initialize", init)
        return {tool["name"] for tool in rpc(client, url, "tools/list", {})["tools"]}


def rpc(client: httpx.Client, url: str, method: str, params: dict[str, Any]) -> dict[str, Any]:
    response = client.post(url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    response.raise_for_status()
    text = response.text
    if response.headers.get("content-type", "").startswith("text/event-stream"):
        text = next(line[5:] for line in text.splitlines() if line.startswith("data:"))
    return json.loads(text)["result"]


class Process:
    """A child process in its own group, its output in a log file."""

    def __init__(self, name: str, command: list[str], cwd: Path, env: dict[str, str], log: Path) -> None:
        self.name, self.log = name, log
        with log.open("wb") as out:
            self.popen = subprocess.Popen(
                command, cwd=cwd, env=env, stdout=out, stderr=subprocess.STDOUT, start_new_session=True
            )

    def text(self) -> str:
        return self.log.read_text(errors="replace") if self.log.exists() else ""

    def tail(self, lines: int = LOG_LINES) -> str:
        return "\n".join(self.text().splitlines()[-lines:])

    def stop(self) -> None:
        """SIGTERM to the group, SIGKILL for whatever is left after 5 s."""
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(self.popen.pid, sig)
            except ProcessLookupError:
                break
            try:
                self.popen.wait(5)
            except subprocess.TimeoutExpired:
                pass


@dataclass
class Stack:
    url: str
    papers_url: str
    data_dir: Path
    warm: bool
    model: str | None = None
    processes: list[Process] = field(default_factory=list)

    def canvas_url(self, board: str) -> str:
        return f"{self.url}/api/mcp/canvas/{board}"

    @property
    def rooms_dir(self) -> Path:
        return self.data_dir / "rooms"

    def papers_log(self) -> str:
        return next((p.text() for p in self.processes if p.name == "papers MCP"), "")

    def logs(self, lines: int = LOG_LINES) -> str:
        return "\n\n".join(f"--- {p.name} (last {lines} lines)\n{p.tail(lines)}" for p in self.processes)

    def wait_ready(self) -> None:
        """Until the board API and the papers MCP answer; raises with the logs if they don't."""
        deadline = time.monotonic() + READY_SECONDS
        board, papers = False, False
        while time.monotonic() < deadline:
            if dead := [p.name for p in self.processes if p.popen.poll() is not None]:
                raise RuntimeError(f"{', '.join(dead)} exited during startup\n{self.logs()}")
            try:
                board = board or httpx.get(
                    f"{self.url}/api/v1/boards", headers={"Authorization": f"Bearer {MEMBER}"}, timeout=2
                ).is_success
                papers = papers or bool(mcp_tools(self.papers_url, timeout=2))
            except (httpx.HTTPError, KeyError, StopIteration, ValueError):
                pass
            if board and papers:
                return
            time.sleep(0.25)
        raise RuntimeError(f"the stack wasn't up after {READY_SECONDS} s\n{self.logs()}")


def show(config: pytest.Config, text: str) -> None:
    """Print past pytest's output capture, so it shows with or without `-s`."""
    capture = config.pluginmanager.getplugin("capturemanager")
    if capture is None:
        print(text)
        return
    with capture.global_and_fixture_disabled():
        print(text, flush=True)


@pytest.fixture(scope="session")
def board_stack(request: pytest.FixtureRequest) -> Iterator[Stack]:
    """Discovery and the board service on free ports with temp data; skips naming what's missing."""
    node, node_problem = node_binary()
    needs = [*missing_keys(), *([node_problem] if node_problem else [])]
    if not shutil.which("uv"):
        needs.append("uv on PATH")
    if needs:
        pytest.skip(f"the live board check needs {', '.join(needs)}")

    data = Path(tempfile.mkdtemp(prefix="live-board-"))
    warm = os.environ.get("LIVE_WARM") == "1"
    papers_port, board_port = free_port(), free_port()
    papers_url = f"http://127.0.0.1:{papers_port}/mcp"
    stack = Stack(f"http://127.0.0.1:{board_port}", papers_url, data / "board", warm, live_model())
    discovery = {} if warm else {"DISCOVERY_DB": str(data / "papers.sqlite3"), "DISCOVERY_VECTORS": str(data / "vectors")}
    # the papers MCP's rerank reads the same variable as the harness
    discovery |= {"SUPER_VL_MODEL": stack.model} if stack.model else {}
    failed_before, up = request.session.testsfailed, False
    try:
        stack.processes.append(
            Process(
                "papers MCP",
                ["uv", "run", "--project", str(REPO / "discovery"), "python", "-m", "discovery"],
                REPO / "discovery",
                child_env(DISCOVERY_PORT=str(papers_port), **discovery),
                data / "discovery.log",
            )
        )
        stack.processes.append(
            Process(
                "board service",
                [node, "server/server.ts"],
                REPO / "client",
                child_env(PORT=str(board_port), DATA_DIR=str(stack.data_dir), PAPERS_MCP_URL=papers_url),
                data / "board.log",
            )
        )
        stack.wait_ready()
        up = True
        yield stack
    finally:
        for process in stack.processes:
            process.stop()
        # A startup error carries the logs itself; either way the data stays for a look.
        if up and request.session.testsfailed > failed_before:
            show(request.config, f"\n{stack.logs()}\n\nThe stack's data is kept in {data}")
        elif up:
            shutil.rmtree(data, ignore_errors=True)
