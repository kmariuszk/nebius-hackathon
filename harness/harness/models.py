"""The Nemotron models on Nebius Token Factory, one per kind of job.

Planning, chat and reading go to Super VL; high-volume tool work goes to
Lightning (docs/Concept.md, NVIDIA model routing). The IDs can be overridden
in `.env`; `uv run python -m harness.check` lists what Token Factory serves.
"""

from __future__ import annotations

from google.adk.models.lite_llm import LiteLlm

from harness import settings

TOKEN_FACTORY_URL = "https://api.tokenfactory.nebius.com/v1/"
SUPER_VL = "nvidia/Nemotron-3.5-Super-VL"
LIGHTNING = "nvidia/Nemotron-3_5-Lightning"
# Seconds one model call may take. Unbounded, a call Token Factory never answers blocked its
# agent for good (Lightning stopped answering for minutes on Oct 21); a timed-out call is retried.
MODEL_TIMEOUT = 120.0


def super_vl() -> LiteLlm:
    """The master and reader agents: planning, chat, papers and figures, listwise rerank."""
    return token_factory(settings.get("SUPER_VL_MODEL", SUPER_VL))


def lightning() -> LiteLlm:
    """The search and context agents: fast, high-volume tool calls."""
    return token_factory(settings.get("LIGHTNING_MODEL", LIGHTNING))


def token_factory(model_id: str) -> LiteLlm:
    """Any Token Factory model, through LiteLLM's OpenAI-compatible provider.

    A failed call, such as a 429 or one that takes longer than `MODEL_TIMEOUT` (or the
    `MODEL_TIMEOUT` setting), is retried twice (LiteLLM backs off exponentially on a 429),
    since the limit is shared by the chat, the background and the papers MCP.
    """
    return LiteLlm(
        model=f"openai/{model_id}",
        api_base=settings.get("TF_BASE_URL", TOKEN_FACTORY_URL),
        api_key=settings.require("TF_API_KEY"),
        num_retries=2,
        timeout=float(settings.get("MODEL_TIMEOUT", "") or MODEL_TIMEOUT),
    )
