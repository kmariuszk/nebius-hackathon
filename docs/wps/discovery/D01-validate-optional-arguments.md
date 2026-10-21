# D01: Validate optional tool arguments

| Field | Value |
| --- | --- |
| Lane | Discovery |
| Size | S |
| Priority | P0 |
| Depends on | — |
| Unblocks | [H04](../agent-harness/H04-first-run-in-90-seconds.md) |
| Milestone | W1 Nothing broken |
| Status | Not started |
| Owner | TBD |

## Goal

The papers MCP treats a placeholder string for an optional argument as not given, and refuses a malformed date with a message the model can act on. No source is ever called with `since=None` as text.

## Context

- Finding F1 (Oct 19): the search agent sent `since: "None"`. `server.py` types `since` as `str | None`, so the string passed, and every source got it: PubMed's `esearch` sent `mindate=None` and returned 0 hits without an error; OpenAlex answered 400 (`filter=from_publication_date:None`); Tavily answered 400 (`start_date: "None"`); `_pubmed_links` raised `ValueError: invalid literal for int() with base 10: 'None'`; `citing` answered 400. The run looked like "no papers on this topic".
- `sources: "None"` and `exclude_ids: "None"` were refused by validation ("Input should be a valid list"), which cost a model retry each.
- The harness drops these placeholders before calling ([H02](../agent-harness/H02-clean-tool-arguments.md)); this WP makes the server safe for every other client (external agents, `adk web`, tests).

## Scope

**In:** typed, validated `since` and optional list arguments on `search` and `find_candidates` (and any other tool with an optional list); a date normaliser in the service; tests.

**Out:** changing what the tools return; validating required arguments beyond what pydantic already does.

## Design

**Types** (`discovery/discovery/server.py`):

```python
PLACEHOLDERS = frozenset({"None", "none", "null", "NULL", "undefined", ""})
DATE = re.compile(r"^\d{4}(-\d{2}(-\d{2})?)?$")

def _unset(value):  # BeforeValidator
    return None if isinstance(value, str) and value.strip() in PLACEHOLDERS else value

def _date(value):  # AfterValidator
    if value is not None and not DATE.match(value):
        raise ValueError("since must be YYYY, YYYY-MM or YYYY-MM-DD")
    return value

Since = Annotated[str | None, BeforeValidator(_unset), AfterValidator(_date)]
OptionalIds = Annotated[list[str] | None, BeforeValidator(_unset)]
```

| Tool | Argument | Type |
| --- | --- | --- |
| `search` | `since` | `Since` |
| `search` | `sources` | `Annotated[list[SearchSource] \| None, BeforeValidator(_unset)]` |
| `find_candidates` | `since` | `Since` |
| `find_candidates` | `exclude_ids` | `OptionalIds` |
| `find_candidates` | `strategies` | `Annotated[list[Strategy] \| None, BeforeValidator(_unset)]` |
| `find_candidates` | `query` | `Annotated[str \| None, BeforeValidator(_unset)]` |
| `rerank`, `score_candidates` | `seed_ids`, `exclude_ids` | `OptionalIds` |

The MCP server builds its argument model from these annotations, so validation happens before the tool runs and the model sees the error text.

**Service** (`discovery/discovery/service.py`): `_since(since) -> str | None` normalises once at the top of `search` and `find_candidates` (placeholders to `None`, the same date check) so direct Python callers get the same rules; `_pubmed_links` reads the year from the normalised value only.

## Tasks

- [ ] `server.py`: `PLACEHOLDERS`, `_unset`, `_date`, `Since`, `OptionalIds`; annotate the arguments above; the docstrings say "leave out when not needed".
- [ ] `service.py`: `_since`, used by `search`, `find_candidates` and `_pubmed_links`.
- [ ] `discovery/tests/test_server_args.py`.
- [ ] `discovery/README.md`: one line on the accepted `since` formats.

## Acceptance criteria

1. Calling the `search` tool with `since="None"` reaches every source with `since` unset: PubMed's `esearch` request has no `mindate`, OpenAlex's has no `from_publication_date` filter and Tavily's body has no `start_date`.
2. `find_candidates(seed_ids=[…], exclude_ids="None", since="null")` runs every strategy and doesn't crash `_pubmed_links`.
3. `since="2020"`, `"2020-05"` and `"2020-05-01"` pass through; `since="last year"` returns a tool error containing "since must be YYYY, YYYY-MM or YYYY-MM-DD".
4. A manual MCP call `search(query="single-cell RNA-seq melanoma", since="None")` against the running server returns papers from `pubmed`, `openalex` and `web`, with no 400 in `skipped`.

## Tests

`discovery/tests/test_server_args.py`: reuse `test_service.py`'s `discovery` fixture and `fake_apis` transport, extended to record each request; call the tools through an in-memory `Client(build_server(discovery))` (as `test_service.py` already does), and assert criteria 1 to 3 on the recorded requests and the tool results.

## Risks

- **The MCP SDK ignores `Annotated` validators in some version:** `mcp==2.3.0` builds a pydantic model from the signature, which honours them; the test proves it, and `_since` in the service is the second line of defence.

## References

- [Agent harness H02: clean the tool arguments](../agent-harness/H02-clean-tool-arguments.md)
- [Group README: shared contracts](README.md#shared-contracts)
