"""Read a board's room straight from its SQLite file, as the board service saved it.

tldraw 5.5's SQLite storage keeps each record as JSON in `documents.state`.
A paper card is drawn as a `CARD_SIZE` box centred on its node (`props.w` ×
`props.h`), so two cards overlap when those boxes do, whatever their nodes do.
"""

from __future__ import annotations

import json
import sqlite3
from collections import Counter
from contextlib import closing
from dataclasses import dataclass
from itertools import combinations
from pathlib import Path
from typing import Any

# The drawn card; from client/shared/shapes.ts once T15 adds it there.
CARD_SIZE = (172.0, 70.0)


@dataclass(frozen=True)
class Box:
    x: float
    y: float
    w: float
    h: float

    def overlaps(self, other: Box) -> bool:
        """True when the boxes share area; touching edges don't count."""
        return (
            self.x < other.x + other.w
            and other.x < self.x + self.w
            and self.y < other.y + other.h
            and other.y < self.y + self.h
        )


class Room:
    """A room's records by ID, with the card geometry and links the live check asserts on."""

    def __init__(self, records: dict[str, dict[str, Any]]) -> None:
        self.records = records

    @classmethod
    def open(cls, rooms_dir: Path, board: str) -> Room:
        files = [p for p in rooms_dir.glob(f"{board}*") if not p.name.endswith(("-wal", "-shm", "-journal"))]
        if not files:
            raise FileNotFoundError(f"no room file for {board} in {rooms_dir}")
        with closing(sqlite3.connect(f"file:{files[0]}?mode=ro", uri=True)) as db:
            rows = db.execute("SELECT id, state FROM documents").fetchall()
        return cls({row_id: json.loads(state) for row_id, state in rows})

    def shapes(self, kind: str | None = None) -> list[dict[str, Any]]:
        return [
            r for r in self.records.values() if r.get("typeName") == "shape" and (kind is None or r.get("type") == kind)
        ]

    def cards(self) -> list[dict[str, Any]]:
        return self.shapes("paper-card")

    def suggestions(self) -> list[dict[str, Any]]:
        return [c for c in self.cards() if c["props"].get("kind") == "suggestion"]

    def page_xy(self, shape: dict[str, Any]) -> tuple[float, float]:
        """The shape's top-left on the page: its x/y plus every parent shape's."""
        x, y = shape.get("x", 0.0), shape.get("y", 0.0)
        parent = self.records.get(shape.get("parentId", ""))
        while parent and parent.get("typeName") == "shape":
            x, y = x + parent.get("x", 0.0), y + parent.get("y", 0.0)
            parent = self.records.get(parent.get("parentId", ""))
        return x, y

    def drawn_box(self, card: dict[str, Any]) -> Box:
        x, y = self.page_xy(card)
        cx, cy = x + card["props"]["w"] / 2, y + card["props"]["h"] / 2
        w, h = CARD_SIZE
        return Box(cx - w / 2, cy - h / 2, w, h)

    def overlaps(self) -> list[tuple[dict[str, Any], dict[str, Any]]]:
        """Every pair of cards whose drawn boxes overlap, seeds included."""
        boxes = [(card, self.drawn_box(card)) for card in self.cards()]
        return [(a, b) for (a, box_a), (b, box_b) in combinations(boxes, 2) if box_a.overlaps(box_b)]

    def links(self) -> Counter[str]:
        """Arrows by `meta.kind` (cites, similar, user)."""
        return Counter(str(a.get("meta", {}).get("kind", "user")) for a in self.shapes("arrow"))

    def clusters(self) -> list[dict[str, Any]]:
        """Frames the agent made for a cluster (`meta.clusterId`)."""
        return [f for f in self.shapes("frame") if f.get("meta", {}).get("clusterId")]


def label(card: dict[str, Any]) -> str:
    """A card as a person would name it in a failure: its title and paper ID."""
    props = card["props"]
    title = props.get("title") or ""
    title = title if len(title) <= 50 else title[:49] + "…"
    return f"{title} ({props.get('paperId')})"
