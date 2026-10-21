"""The live check's room maths: drawn card boxes and overlaps, on hand-made records."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from live.room import CARD_SIZE, Box, Room


def card(paper_id: str, x: float, y: float, size: float = 40, parent: str = "page:page") -> dict[str, Any]:
    props = {"paperId": paper_id, "title": paper_id, "kind": "suggestion", "w": size, "h": size}
    return {"id": f"shape:{paper_id}", "typeName": "shape", "type": "paper-card", "x": x, "y": y,
            "parentId": parent, "props": props, "meta": {}}


def room(*records: dict[str, Any]) -> Room:
    return Room({r["id"]: r for r in records})


def test_the_drawn_box_is_the_card_size_centred_on_the_node():
    assert room().drawn_box(card("a", 100, 100, size=40)) == Box(120 - 86, 120 - 35, *CARD_SIZE)


def test_nodes_apart_whose_drawn_cards_overlap_count():
    # 100 apart: the 40 px nodes are clear of each other, the 172 px cards aren't.
    a, b = card("a", 0, 0), card("b", 100, 0)
    assert [(x["id"], y["id"]) for x, y in room(a, b).overlaps()] == [("shape:a", "shape:b")]


def test_cards_a_card_width_apart_or_on_another_row_dont_overlap():
    a, b, c = card("a", 0, 0), card("b", 172, 0), card("c", 0, 70)
    assert room(a, b, c).overlaps() == []


def test_a_card_in_a_frame_is_placed_through_its_parent():
    frame = {"id": "shape:f", "typeName": "shape", "type": "frame", "x": 1000, "y": 500, "parentId": "page:page",
             "props": {"w": 600, "h": 400}, "meta": {"clusterId": "c1"}}
    inside, outside = card("a", 10, 10, parent="shape:f"), card("b", 1010, 510)
    r = room(frame, inside, outside)
    assert r.page_xy(inside) == (1010, 510)
    assert len(r.overlaps()) == 1
    assert r.clusters() == [frame]


def test_links_by_kind_and_opening_the_room_file(tmp_path: Path):
    arrows = [{"id": f"shape:l{i}", "typeName": "shape", "type": "arrow", "x": 0, "y": 0, "parentId": "page:page",
               "props": {}, "meta": {"kind": kind}} for i, kind in enumerate(["cites", "similar", "similar"])]
    records = [card("a", 0, 0), *arrows]
    with sqlite3.connect(tmp_path / "b_test.db") as db:
        db.execute("CREATE TABLE documents (id TEXT PRIMARY KEY, state BLOB NOT NULL, lastChangedClock INTEGER)")
        db.executemany("INSERT INTO documents VALUES (?, ?, 0)", [(r["id"], json.dumps(r)) for r in records])
    opened = Room.open(tmp_path, "b_test")
    assert len(opened.cards()) == 1
    assert opened.links() == {"cites": 1, "similar": 2}
