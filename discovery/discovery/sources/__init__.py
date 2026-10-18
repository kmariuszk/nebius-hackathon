"""Clients for the scholarly APIs and Tavily.

Each module takes an `httpx.AsyncClient` so tests can pass one backed by a
mock transport. A source that cannot run (no key, say) raises `Skipped`; the
tools report it and carry on with the other sources.
"""

from __future__ import annotations

import asyncio
import os
import re
import time

import httpx

_KEY_PARAM = re.compile(r"(api_key=)[^&\s'\"]+")


class Skipped(Exception):
    """A source could not run; the message says why and how to fix it."""


def key(name: str, purpose: str) -> str:
    """An API key from the environment; raises `Skipped` naming the variable if unset."""
    value = os.environ.get(name, "").strip()
    if not value:
        raise Skipped(f"{name} is not set ({purpose})")
    return value


def raise_for_status(response: httpx.Response) -> None:
    """`response.raise_for_status()` with the `api_key` in the URL masked, since the
    message reaches the logs and the `skipped` notes agents and researchers see."""
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as error:
        message = _KEY_PARAM.sub(r"\1***", str(error))
        raise httpx.HTTPStatusError(message, request=error.request, response=error.response) from None


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
