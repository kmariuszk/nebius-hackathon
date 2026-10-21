"""Live: the master fills a real board from the five demo seeds (H01).

Run with `uv run pytest -m live -k master_board -s`. `board_stack` starts the
papers MCP and the board service; the test runs `master` on Nemotron through
the real ACP adapter, waits for the background reading, then checks the room
file, the activity feed and the tool cards, and writes a report to
`tests/live/reports/`. About 10 minutes and a few dozen model calls. Timing is
asserted only with LIVE_TIMING=strict.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
from acp import text_block

from fixtures.acp_client import HARNESS_DIR, harness
from live.board_stack import SUPER_VL, MEMBER, Stack, board_stack, child_env, mcp_tools, show  # noqa: F401
from live.room import Room, label

pytestmark = pytest.mark.live

QUESTION = "Which single-cell methods help study melanoma immune cells?"
# Word for word what the Start page sends first: `onboardingPrompt` in client/client/pages/Room.tsx.
ONBOARDING_PROMPT = (
    f'Start this board. The research question is: "{QUESTION}". The seed papers are already on the board. '
    "Find related papers, put the best ones on the board near the seeds, and tell me what you found."
)
SEEDS = (
    "10.1126/science.aad0501",
    "10.1016/j.cell.2018.10.038",
    "10.1038/s41586-021-03704-y",
    "10.1038/s41586-022-04682-5",
    "10.1158/1078-0432.CCR-21-1694",
)
PAPERS_TOOLS = frozenset({"search", "find_candidates", "score_candidates", "rerank", "get_paper", "resolve_seed"})
# The argument-cleaning contract in docs/wps/agent-harness/README.md.
PLACEHOLDERS = frozenset({"None", "none", "null", "NULL", "undefined", ""})
HTTP_400 = "400 Bad Request"
TURN_SECONDS, FILL_SECONDS, POLL_SECONDS = 600, 900, 10
TARGETS = {"tFirstCard": 90, "tAnswer": 120, "tFilled": 300}
MIN_SUGGESTIONS = 4
REPORTS = Path(__file__).parent / "reports"
# The harness logs every LiteLLM call once through its own log format (and once more through LiteLLM's).
MODEL_CALL = re.compile(r"INFO LiteLLM: \nLiteLLM completion\(\)")
KEY_PARAM = re.compile(r"(api_key=)[^&\s'\"]+")
# What the harness's clean_args drops before the call (H02); the tool cards show the model's own arguments.
DROPPED = re.compile(r"INFO harness\.agents\.args: (\w+): dropped (\d+) placeholder")


def tool_cards(updates: list[Any]) -> list[dict[str, Any]]:
    """Each tool card's start and end merged: title, kind, status, raw_input, raw_output, `_meta`."""
    cards: dict[str, dict[str, Any]] = {}
    for u in updates:
        if u.session_update not in ("tool_call", "tool_call_update"):
            continue
        card = cards.setdefault(u.tool_call_id, {"meta": {}})
        for name in ("title", "kind", "status", "raw_input", "raw_output"):
            if (value := getattr(u, name, None)) is not None:
                card[name] = value
        card["meta"].update(u.field_meta or {})
    return list(cards.values())


def tool_name(card: dict[str, Any]) -> str:
    return card.get("title", "").split(": ", 1)[-1]


def papers_cards(cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # The master's `search` is the search agent (kind "think"), not the papers tool.
    return [c for c in cards if tool_name(c) in PAPERS_TOOLS and c.get("kind") != "think"]


def placeholders(cards: list[dict[str, Any]]) -> list[str]:
    found = []
    for card in papers_cards(cards):
        for arg, value in (card.get("raw_input") or {}).items():
            values = value if isinstance(value, list) else [value]
            found += [f"{card['title']} {arg}={v!r}" for v in values if isinstance(v, str) and v in PLACEHOLDERS]
    return found


def dropped_placeholders(stderr: str) -> int:
    """Placeholder arguments the harness dropped from papers tool calls before they reached the MCP."""
    return sum(int(n) for tool, n in DROPPED.findall(stderr) if tool in PAPERS_TOOLS)


def tool_result(output: Any) -> Any:
    """The tool's own result from a card's raw output: MCP structured content, its JSON text, or the text."""
    if isinstance(output, dict):
        if isinstance(output.get("structuredContent"), dict):
            return output["structuredContent"]
        texts = [c.get("text") for c in output.get("content") or [] if isinstance(c, dict) and c.get("text")]
        output = texts[0] if texts else output
    if isinstance(output, str):
        try:
            return json.loads(output)
        except ValueError:
            return output
    return output


def skipped(result: Any) -> list[str]:
    """Every `skipped` entry in a result; in a result the card cut short, the HTTP 400 notes still visible."""
    if isinstance(result, str):
        return re.findall(rf"[^\"\\]*{HTTP_400}[^\"\\]*", result)
    if isinstance(result, list):
        return [entry for item in result for entry in skipped(item)]
    if not isinstance(result, dict):
        return []
    found = []
    for key, value in result.items():
        if key == "skipped" and isinstance(value, list):
            found += [v if isinstance(v, str) else json.dumps(v) for v in value]
        else:
            found += skipped(value)
    return found


def http_400s(cards: list[dict[str, Any]], papers_log: str) -> list[str]:
    """Skipped sources that answered HTTP 400. Cards cut results at 8 KB, so the papers MCP's log counts too."""
    from_cards = [s for c in papers_cards(cards) for s in skipped(tool_result(c.get("raw_output"))) if HTTP_400 in s]
    # Each failed source logs its traceback once, ending in the HTTPStatusError line.
    from_log = [line.strip() for line in papers_log.splitlines() if HTTP_400 in line and "/mcp HTTP" not in line]
    found = from_cards if len(from_cards) >= len(from_log) else from_log
    return [" ".join(KEY_PARAM.sub(r"\1***", s).split()) for s in found]


def seconds_after(at: str, started: float) -> float:
    return round(datetime.fromisoformat(at).timestamp() - started, 1)


def timings(events: list[dict[str, Any]], started: float, answered: float | None) -> dict[str, float | None]:
    """tFirstCard: the first `paper.added`; tFilled: the last `mark_working` off; tAnswer: `prompt` returned."""
    added = [seconds_after(e["at"], started) for e in events if e["type"] == "paper.added"]
    filled = [
        seconds_after(e["at"], started)
        for e in events
        if e["type"] == "paper.updated" and e["payload"].get("tool") == "mark_working"
        and e["payload"].get("working") is False
    ]
    return {
        "tFirstCard": min((t for t in added if t >= 0), default=None),
        "tAnswer": round(answered - started, 1) if answered else None,
        "tFilled": max(filled, default=None),
    }


def names(pairs: list[str], limit: int = 8) -> str:
    return "; ".join(pairs[:limit]) + (f"; and {len(pairs) - limit} more" if len(pairs) > limit else "")


async def wait_until_read(api: httpx.AsyncClient, board: str) -> list[dict[str, Any]]:
    """Polls the papers until none is `working`, or FILL_SECONDS pass; returns the last list."""
    deadline = time.monotonic() + FILL_SECONDS
    while True:
        papers = (await api.get(f"/boards/{board}/papers")).raise_for_status().json()
        if not any(p["working"] for p in papers) or time.monotonic() > deadline:
            return papers
        await asyncio.sleep(POLL_SECONDS)


def table(report: dict[str, Any], path: Path) -> str:
    t, c = report["timings"], report["counts"]
    cache = "warm" if report["warm"] else "cold"
    moments = {"tFirstCard": "first card", "tAnswer": "answer", "tFilled": "every card read"}
    rows = [
        f"\nLive board check on {report['board']} ({report['seeds']} seeds, {cache} cache, {report['model']})",
        f"  {'moment':<16}{'seconds':>8}{'target':>8}",
        *(f"  {moment:<16}{'—' if t[k] is None else t[k]:>8}{TARGETS[k]:>8}" for k, moment in moments.items()),
        (
            f"  suggestions {c['suggestions']} · overlaps {c['overlaps']} · no why {c['missingWhy']} "
            f"(gaps only {c['gapsOnly']}) · cites {c['citesLinks']} · similar {c['similarLinks']} · "
            f"clusters {c['clusters']}"
        ),
        (
            f"  placeholder args {c['placeholderArgs']} reached ({c['placeholderArgsWritten']} written) · "
            f"HTTP 400 skips {c['http400Skips']} · "
            f"model calls {c['modelCalls']} · chat cost ${report['costUsd']:.4f}"
        ),
        f"  report: {path}",
    ]
    if report.get("timingNote"):
        rows.insert(-1, f"  {report['timingNote']}")
    return "\n".join(rows)


@dataclass
class Run:
    """What one onboarding turn left behind, read before the harness closed."""

    board: str
    listed: set[str]
    stop: str
    started: float
    answered: float | None
    room: Room
    events: list[dict[str, Any]]
    updates: list[Any]
    stderr: str


async def run_master(stack: Stack, agent: str = "master") -> Run:
    """A fresh board with the seeds, the onboarding prompt, then the background reading."""
    headers = {"Authorization": f"Bearer {MEMBER}"}
    async with httpx.AsyncClient(base_url=f"{stack.url}/api/v1", headers=headers, timeout=120) as api:
        board = (await api.post("/boards", json={"question": QUESTION})).raise_for_status().json()["id"]
        for doi in SEEDS:
            (await api.post(f"/boards/{board}/seeds", json={"doi": doi})).raise_for_status()
        listed = mcp_tools(stack.papers_url) | mcp_tools(stack.canvas_url(board), MEMBER)
        env: dict[str, str | None] = {
            "HARNESS_AGENT": agent, "HARNESS_MODEL": None, "PAPERS_MCP_URL": stack.papers_url,
            "LOG_LEVEL": "INFO", "TF_API_KEY": child_env().get("TF_API_KEY"), "SUPER_VL_MODEL": stack.model,
        }
        async with harness(env=env) as h:
            session = await h.start(stack.canvas_url(board), member=MEMBER)
            started, answered = time.time(), None
            try:
                prompt = h.conn.prompt(session_id=session, prompt=[text_block(ONBOARDING_PROMPT)])
                stop, answered = (await asyncio.wait_for(prompt, TURN_SECONDS)).stop_reason, time.time()
            except TimeoutError:
                stop = f"no answer within {TURN_SECONDS} s"
            except Exception as error:  # noqa: BLE001 - it fails the check with the rest
                stop = f"{type(error).__name__}: {error}"
            if answered:
                await wait_until_read(api, board)
            # Closing the chat clears the badges still on, so the room is read first.
            room = Room.open(stack.rooms_dir, board)
            events = (await api.get(f"/boards/{board}/activity", params={"limit": 500})).raise_for_status().json()
            try:
                await h.stop(timeout=15)
            except TimeoutError:
                pass
    return Run(board, listed, stop, started, answered, room, events, h.client.updates, h.stderr_text())


def build_report(run: Run, stack: Stack) -> dict[str, Any]:
    """The report in the group README's format, plus what the checks name."""
    cards, room = tool_cards(run.updates), run.room
    suggestions = room.suggestions()
    no_why = [s for s in suggestions if not s["props"].get("oneLine", "").strip()]
    details = {
        "overlaps": [f"{label(a)} × {label(b)}" for a, b in room.overlaps()],
        "noWhyNoGap": [label(s) for s in no_why if not s["props"].get("gaps")],
        "stillReading": [label(s) for s in suggestions if s["props"].get("working")],
        "placeholderArgs": placeholders(cards),
        "http400Skips": http_400s(cards, stack.papers_log()),
        "figures": sum(1 for card in room.cards() if card["props"].get("figure")),
    }
    reached = max(0, len(details["placeholderArgs"]) - dropped_placeholders(run.stderr))
    links = room.links()
    usage = [u for u in run.updates if u.session_update == "usage_update" and u.cost]
    stand_in = os.environ.get("LIVE_TIMING") == "strict" and stack.model
    return {
        "board": run.board,
        "seeds": len(SEEDS),
        "warm": stack.warm,
        "model": stack.model or SUPER_VL,
        "timings": timings(run.events, run.started, run.answered),
        "counts": {
            "suggestions": len(suggestions),
            "overlaps": len(details["overlaps"]),
            "missingWhy": len(no_why),
            "gapsOnly": len(no_why) - len(details["noWhyNoGap"]),
            "citesLinks": links["cites"],
            "similarLinks": links["similar"],
            "clusters": len(room.clusters()),
            "placeholderArgs": reached,
            "placeholderArgsWritten": len(details["placeholderArgs"]),
            "http400Skips": len(details["http400Skips"]),
            "modelCalls": len(MODEL_CALL.findall(run.stderr)),
        },
        "costUsd": usage[-1].cost.amount if usage else 0.0,
        "stopReason": run.stop,
        # the targets are for the demo's models; a stand-in model's timings are only reported
        **({"timingNote": f"timing not asserted: {stack.model} stands in for Super VL"} if stand_in else {}),
        "listedTools": sorted(run.listed),
        "details": details,
        "toolCards": [
            {"title": c.get("title"), "status": c.get("status"), "model": c["meta"].get("model"),
             "seconds": c["meta"].get("seconds"), "costUsd": c["meta"].get("costUsd"),
             **({"error": str(tool_result(c.get("raw_output")))[:500]} if c.get("status") == "failed" else {})}
            for c in cards
        ],
    }


def failures(report: dict[str, Any], listed: set[str]) -> list[str]:
    """What's wrong with the run, each naming the cards or calls at fault."""
    t, c, d = report["timings"], report["counts"], report["details"]
    found = []
    if report["stopReason"] != "end_turn":
        found.append(f"the turn ended with {report['stopReason']!r}, not end_turn")
    if c["suggestions"] < MIN_SUGGESTIONS:
        found.append(f"{c['suggestions']} suggestions on the board, fewer than {MIN_SUGGESTIONS}")
    if d["overlaps"]:
        found.append(f"{c['overlaps']} pairs of cards overlap: {names(d['overlaps'])}")
    if reading := d["stillReading"]:
        found.append(f"{len(reading)} suggestions still show the reading badge: {names(reading)}")
    if neither := d["noWhyNoGap"]:
        found.append(f"{len(neither)} suggestions have no 'Why it matters' and no gap: {names(neither)}")
    if c["placeholderArgs"]:
        found.append(
            f"{c['placeholderArgs']} placeholder arguments reached the papers MCP (the model wrote "
            f"{c['placeholderArgsWritten']}): {names(d['placeholderArgs'])}"
        )
    if d["http400Skips"]:
        found.append(f"{c['http400Skips']} sources were skipped with HTTP 400: {names(d['http400Skips'], 3)}")
    if "citation_links" in listed and not c["citesLinks"]:
        found.append("no cites link, though the papers MCP lists citation_links")
    if "apply_clusters" in listed and not 2 <= c["clusters"] <= 6:
        found.append(f"{c['clusters']} cluster frames, not 2 to 6, though the canvas MCP lists apply_clusters")
    if "get_figures" in listed and not d["figures"]:
        found.append("no card has a figure, though the papers MCP lists get_figures")
    if os.environ.get("LIVE_TIMING") == "strict" and "timingNote" not in report:
        found += [
            f"{key} {'never came' if t[key] is None else f'was {t[key]} s'}, target {target} s"
            for key, target in TARGETS.items()
            if t[key] is None or t[key] > target
        ]
    return found


async def test_master_board_fills_from_the_demo_seeds(board_stack: Stack, request: pytest.FixtureRequest):  # noqa: F811
    run = await run_master(board_stack)
    report = build_report(run, board_stack)
    report["failures"] = failures(report, run.listed)
    REPORTS.mkdir(exist_ok=True)
    path = REPORTS / f"{datetime.now(UTC):%Y%m%dT%H%M%SZ}.json"
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    show(request.config, table(report, path.relative_to(HARNESS_DIR)))
    assert not report["failures"], "\n".join(report["failures"])
