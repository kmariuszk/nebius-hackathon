"""Settings read from the environment and the repo's `.env`.

Variables already set in the environment win over `.env`. `adk web` also
loads the nearest `.env` above an agent's folder, so both paths see the same
values. `.env.example` at the repo root lists every variable.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv


class MissingSetting(RuntimeError):
    """A required environment variable is not set."""


def load_env() -> None:
    """Load the nearest `.env` above this package, keeping variables already set."""
    for folder in Path(__file__).resolve().parents:
        candidate = folder / ".env"
        if candidate.is_file():
            load_dotenv(candidate, override=False)
            return


def get(name: str, default: str | None = None) -> str | None:
    """The variable's value, or `default` when it is unset or blank."""
    value = os.environ.get(name, "").strip()
    return value or default


def require(name: str) -> str:
    """The variable's value; raises `MissingSetting` with a fix when it is unset."""
    value = get(name)
    if value is None:
        raise MissingSetting(
            f"{name} is not set. Copy .env.example to .env at the repo root and fill it in."
        )
    return value


load_env()
