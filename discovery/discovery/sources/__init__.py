"""Clients for the scholarly APIs and Tavily.

Each module takes an `httpx.AsyncClient` so tests can pass one backed by a
mock transport. A source that cannot run (no key, say) raises `Skipped`; the
tools report it and carry on with the other sources.
"""

from __future__ import annotations

import asyncio
import os
import time


class Skipped(Exception):
    """A source could not run; the message says why and how to fix it."""


def key(name: str, purpose: str) -> str:
    """An API key from the environment; raises `Skipped` naming the variable if unset."""
    value = os.environ.get(name, "").strip()
    if not value:
        raise Skipped(f"{name} is not set ({purpose})")
    return value


class Throttle:
    """Spaces requests to one API at most `per_second` a second."""

    def __init__(self, per_second: float) -> None:
        self.interval = 1 / per_second
        self._next = 0.0

    async def wait(self) -> None:
        now = time.monotonic()
        slot = max(now, self._next)
        self._next = slot + self.interval
        if slot > now:
            await asyncio.sleep(slot - now)
