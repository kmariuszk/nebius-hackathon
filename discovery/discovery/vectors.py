"""Paper embeddings in LanceDB: the `paper_vectors` table of docs/Concept.md, Storage.

A row holds one paper's vector together with the text and model it came
from, so a paper whose abstract arrives later, or a change of model, is
embedded again instead of reusing a stale vector.
"""

from __future__ import annotations

import logging
from pathlib import Path

import lancedb
import numpy as np
import pyarrow as pa

log = logging.getLogger(__name__)

TABLE = "paper_vectors"


class VectorStore:
    def __init__(self, path: str | Path) -> None:
        self._db = lancedb.connect(str(path))

    def get(self, model: str, texts: dict[str, str]) -> dict[str, np.ndarray]:
        """Stored vectors for paper ID → text, where both the text and model still match."""
        if not texts or TABLE not in self._db.list_tables().tables:
            return {}
        ids = ", ".join("'" + paper_id.replace("'", "''") + "'" for paper_id in texts)
        rows = (
            self._db.open_table(TABLE)
            .search()
            .where(f"paper_id IN ({ids})")
            .select(["paper_id", "model", "text", "vector"])
            .limit(None)
            .to_list()
        )
        return {
            row["paper_id"]: np.asarray(row["vector"], dtype=np.float32)
            for row in rows
            if row["model"] == model and row["text"] == texts[row["paper_id"]]
        }

    def put(self, model: str, vectors: dict[str, tuple[str, list[float]]]) -> None:
        """Store paper ID → (text, vector), replacing each paper's previous vector."""
        if not vectors:
            return
        dimension = len(next(iter(vectors.values()))[1])
        table = self._table(dimension)
        rows = [
            {"paper_id": paper_id, "model": model, "text": text, "vector": vector}
            for paper_id, (text, vector) in vectors.items()
        ]
        table.merge_insert("paper_id").when_matched_update_all().when_not_matched_insert_all().execute(
            rows
        )

    def _table(self, dimension: int) -> lancedb.table.Table:
        """The table, recreated if a new model's vectors have another dimension."""
        if TABLE in self._db.list_tables().tables:
            table = self._db.open_table(TABLE)
            if table.schema.field("vector").type.list_size == dimension:
                return table
            log.info("Embedding dimension is now %d; dropping the old %s", dimension, TABLE)
            self._db.drop_table(TABLE)
        schema = pa.schema(
            [
                pa.field("paper_id", pa.string()),
                pa.field("model", pa.string()),
                pa.field("text", pa.string()),
                pa.field("vector", pa.list_(pa.float32(), dimension)),
            ]
        )
        return self._db.create_table(TABLE, schema=schema, exist_ok=True)
