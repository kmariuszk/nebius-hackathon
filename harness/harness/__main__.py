"""`python -m harness`: the ACP agent on stdio, one process per chat.

    uv run python -m harness            # the agent named by HARNESS_AGENT (board_assistant)
    uv run python -m harness --echo     # no model, no keys: same as HARNESS_AGENT=echo

The board service's ACP pipe starts one per chat. Nothing but ACP may reach
stdout, so before anything else is imported the real stdout is kept for ACP
and fd 1 and `sys.stdout` are pointed at stderr. Logs go to stderr at INFO
(`LOG_LEVEL` changes it).
"""

from __future__ import annotations

import os
import sys

# Stdout guard: ACP writes to a private copy of fd 1, and fd 1 itself now goes to
# stderr, so a stray print or a library banner can't corrupt the stream.
_ACP_FD = os.dup(1)
os.dup2(2, 1)
sys.stdout = sys.stderr

# Scripted runs never call Token Factory, but agents build their models on import;
# a placeholder key also keeps a real one in .env from being loaded.
if os.environ.get("HARNESS_MODEL", "").startswith("scripted:") and not os.environ.get("TF_API_KEY"):
    os.environ["TF_API_KEY"] = "scripted"

import argparse  # noqa: E402
import asyncio  # noqa: E402
import logging  # noqa: E402
import signal  # noqa: E402

from acp import run_agent  # noqa: E402
from acp.core import DEFAULT_STDIO_BUFFER_LIMIT_BYTES  # noqa: E402
from acp.stdio import _WritePipeProtocol  # noqa: E402

from harness import settings  # noqa: E402
from harness.acp.adapter import BoardHarness  # noqa: E402

log = logging.getLogger("harness")

# Stop waits this long for open turns to wind down and MCP sessions to close.
SHUTDOWN_SECONDS = 3.0


async def acp_streams() -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    """stdin and the kept stdout as asyncio streams, built like `acp.stdio_streams` (0.12.1, POSIX)."""
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=DEFAULT_STDIO_BUFFER_LIMIT_BYTES)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    protocol = _WritePipeProtocol()
    transport, _ = await loop.connect_write_pipe(lambda: protocol, os.fdopen(_ACP_FD, "wb", buffering=0))
    return reader, asyncio.StreamWriter(transport, protocol, None, loop)


async def main(agent: str) -> None:
    harness = BoardHarness(agent)
    reader, writer = await acp_streams()
    # SIGTERM ends the connection the same way stdin closing does.
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, asyncio.current_task().cancel)
    log.info("ACP agent ready on stdio (agent: %s)", agent)
    try:
        await run_agent(harness, input_stream=writer, output_stream=reader)
    except asyncio.CancelledError:
        log.info("SIGTERM, shutting down")
    finally:
        await harness.shutdown(SHUTDOWN_SECONDS)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(prog="python -m harness", description=__doc__.splitlines()[0])
    parser.add_argument("--echo", action="store_true", help="run the model-free echo agent")
    args = parser.parse_args()
    logging.basicConfig(
        level=settings.get("LOG_LEVEL", "INFO").upper(),
        stream=sys.stderr,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    asyncio.run(main("echo" if args.echo else settings.get("HARNESS_AGENT", "board_assistant")))
    # Library threads (LiteLLM, telemetry) must not keep a finished chat's process alive.
    logging.shutdown()
    os._exit(0)
