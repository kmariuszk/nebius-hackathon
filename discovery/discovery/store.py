"""SQLite store of paper records, keyed by paper ID with every alias indexed.

Saving a paper that shares any identifier with a stored one merges the two
under the stored paper's ID, which is how candidates from different sources
are deduplicated by DOI, PMID and the rest.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from discovery.papers import Paper, format_id, parse_id

SCHEMA = """
CREATE TABLE IF NOT EXISTS papers (
    paper_id TEXT PRIMARY KEY,
    record TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS paper_aliases (
    alias TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES papers (paper_id)
);
"""


class Store:
    def __init__(self, path: str | Path = ":memory:") -> None:
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.executescript(SCHEMA)

    def save(self, paper: Paper) -> Paper:
        """Store `paper`, merged into any stored paper it shares an identifier with."""
        aliases = paper.aliases()
        existing_id = self._find(aliases)
        if existing_id:
            paper = self._load(existing_id).merge(paper)
            paper.paper_id = existing_id
        else:
            paper.paper_id = paper.preferred_id()
        with self._db:
            self._db.execute(
                "INSERT INTO papers (paper_id, record, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT (paper_id) DO UPDATE SET record = excluded.record, "
                "updated_at = excluded.updated_at",
                (paper.paper_id, json.dumps(paper.to_record()), datetime.now(UTC).isoformat()),
            )
            self._db.executemany(
                "INSERT OR IGNORE INTO paper_aliases (alias, paper_id) VALUES (?, ?)",
                [(alias, paper.paper_id) for alias in paper.aliases()],
            )
        return paper

    def get(self, paper_id: str) -> Paper | None:
        """The stored paper with this ID or alias, or None."""
        found = self._find([format_id(*parse_id(paper_id))])
        return self._load(found) if found else None

    def _find(self, aliases: list[str]) -> str | None:
        for alias in aliases:
            row = self._db.execute(
                "SELECT paper_id FROM paper_aliases WHERE alias = ?", (alias,)
            ).fetchone()
            if row:
                return row[0]
        return None

    def _load(self, paper_id: str) -> Paper:
        (record,) = self._db.execute(
            "SELECT record FROM papers WHERE paper_id = ?", (paper_id,)
        ).fetchone()
        return Paper.from_record(json.loads(record))
