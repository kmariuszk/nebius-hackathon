"""The ACP adapter behind `python -m harness`.

`adapter.BoardHarness` is the ACP agent; `worker.SessionWorker` runs one
session's prompts through an ADK runner; `mapping` converts prompts and
events; `trace.AcpTracePlugin` turns every tool call, including those inside
sub-agents, into a tool card; `scripted` replays recorded model turns.
"""
