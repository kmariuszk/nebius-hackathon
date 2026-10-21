"""What each model costs and holds, for the "model, time and cost" line on tool cards.

USD per million input and output tokens, from Token Factory's model catalogue
(https://tokenfactory.nebius.com/model-catalog.md, checked Oct 18, 2026).
`MODEL_PRICES_JSON` overrides or adds models, for example
`{"nvidia/Nemotron-3.5-Super-VL": [0.3, 0.9]}`.
"""

from __future__ import annotations

import json
import logging

from harness import settings

log = logging.getLogger(__name__)

PRICES: dict[str, tuple[float, float]] = {
    "nvidia/Nemotron-3.5-Super-VL": (0.30, 0.90),
    "nvidia/Nemotron-3_5-Lightning": (0.06, 0.24),
    "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": (0.06, 0.24),
}

# Context windows in tokens, from the same catalogue.
CONTEXT_WINDOWS: dict[str, int] = {
    "nvidia/Nemotron-3.5-Super-VL": 1_024_000,
    "nvidia/Nemotron-3_5-Lightning": 1_024_000,
    "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": 262_000,
}
DEFAULT_CONTEXT_WINDOW = 128_000


def prices() -> dict[str, tuple[float, float]]:
    table = dict(PRICES)
    if override := settings.get("MODEL_PRICES_JSON"):
        try:
            table.update({model: (float(i), float(o)) for model, (i, o) in json.loads(override).items()})
        except (ValueError, TypeError) as error:
            log.warning("MODEL_PRICES_JSON ignored: %s", error)
    return table


def cost(model: str, input_tokens: int, output_tokens: int) -> float:
    """USD for one model call; 0 for a model with no known price."""
    price_in, price_out = prices().get(model, (0.0, 0.0))
    return (input_tokens * price_in + output_tokens * price_out) / 1_000_000


def context_window(model: str) -> int:
    return CONTEXT_WINDOWS.get(model, DEFAULT_CONTEXT_WINDOW)
