"""Token Factory's chat completions, as `rerank` and the cluster names call them."""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from typing import Any

import httpx

from discovery.sources import key

TOKEN_FACTORY_URL = "https://api.tokenfactory.nebius.com/v1/"


async def chat_completion(
    client: httpx.AsyncClient,
    model: str,
    messages: list[dict[str, Any]],
    *,
    max_tokens: int,
    timeout: float,
    thinking: bool = False,
) -> dict[str, Any]:
    """`model`'s JSON reply to `messages` at temperature 0, with reasoning off unless `thinking`.

    Raises `Skipped` without `TF_API_KEY`, and `httpx.HTTPError` when the call fails.
    """
    base = os.environ.get("TF_BASE_URL", "").strip() or TOKEN_FACTORY_URL
    headers = {"Authorization": f"Bearer {key('TF_API_KEY', 'Nebius Token Factory')}"}
    body = {
        "model": model,
        "messages": messages,
        "response_format": {"type": "json_object"},
        "temperature": 0,
        "max_tokens": max_tokens,
        **({} if thinking else {"chat_template_kwargs": {"enable_thinking": False}}),
    }
    response = await client.post(base.rstrip("/") + "/chat/completions", json=body, headers=headers, timeout=timeout)
    response.raise_for_status()
    return response.json()


def first_json_object(content: str, accept: Callable[[dict[str, Any]], bool]) -> dict[str, Any] | None:
    """The first JSON object in `content` that `accept` takes, also inside a code fence or prose."""
    decoder = json.JSONDecoder()
    for start in (i for i, char in enumerate(content) if char == "{"):
        try:
            value, _ = decoder.raw_decode(content, start)
        except ValueError:
            continue
        if isinstance(value, dict) and accept(value):
            return value
    return None
