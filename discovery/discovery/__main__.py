"""Serve the papers MCP: `uv run python -m discovery`, at http://127.0.0.1:8001/mcp by default."""

import logging
import os
from pathlib import Path

import httpx

from discovery.server import build_server
from discovery.service import Discovery
from discovery.store import Store

DEFAULT_DB = Path(__file__).resolve().parents[1] / "data" / "papers.sqlite3"

logging.basicConfig(level=logging.INFO)
client = httpx.AsyncClient(
    timeout=30,
    follow_redirects=True,
    headers={"User-Agent": "paper-discovery-canvas/0.1 (Nebius hackathon)"},
)
store = Store(os.environ.get("DISCOVERY_DB", DEFAULT_DB))
build_server(Discovery(client, store)).run(
    "streamable-http",
    host=os.environ.get("DISCOVERY_HOST", "127.0.0.1"),
    port=int(os.environ.get("DISCOVERY_PORT", "8001")),
    streamable_http_path="/mcp",
    stateless_http=True,
)
