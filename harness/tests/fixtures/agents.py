"""Agents for adapter tests, picked with `HARNESS_AGENT=fixtures.agents:<name>` (tests/ on PYTHONPATH)."""

from __future__ import annotations

import os

from google.adk.agents import LlmAgent

from harness.board import assistant
from harness.board.tools import BoardTools


def shout(text: str) -> dict:
    """Writes `text` to stdout the careless ways: print() and straight to fd 1.

    Args:
        text: What to write.
    """
    print(text)
    os.write(1, f"{text} (fd 1)\n".encode())
    return {"ok": True}


def loud(board: BoardTools | None = None) -> LlmAgent:
    """board_assistant plus a tool that prints to stdout."""
    agent = assistant.build(board)
    agent.tools.append(shout)
    return agent
