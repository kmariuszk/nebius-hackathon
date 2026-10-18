import json
import re
from pathlib import Path

from harness.board.ids import new_run_id, paper_shape_id

FIXTURE = Path(__file__).parent / "../../client/shared/fixtures/paper-ids.json"


def test_paper_shape_ids_match_the_typescript_helper():
    pairs = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert pairs, "the shared fixture is empty"
    for paper_id, shape_id in pairs:
        assert paper_shape_id(paper_id) == shape_id, paper_id


def test_run_ids_are_run_plus_twelve_hex():
    ids = {new_run_id() for _ in range(50)}
    assert len(ids) == 50
    assert all(re.fullmatch(r"run_[0-9a-f]{12}", run_id) for run_id in ids)
