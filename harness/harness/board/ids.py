"""Shape and run IDs the harness, the canvas MCP and the browser agree on.

Mirrors `client/shared/ids.ts`; both are tested against
`client/shared/fixtures/paper-ids.json`.
"""

from __future__ import annotations

import re
import secrets

_UNSAFE = re.compile(r"[^A-Za-z0-9_-]")


def slug(paper_id: str) -> str:
    """Every code point outside [A-Za-z0-9_-] becomes `_`."""
    return _UNSAFE.sub("_", paper_id)


def paper_shape_id(paper_id: str) -> str:
    """One card per paper: writing the same paper twice updates the same shape."""
    return f"shape:paper-{slug(paper_id)}"


def new_run_id() -> str:
    """One run per ACP prompt turn, sent to the canvas MCP as `X-Run-Id`."""
    return "run_" + secrets.token_hex(6)
