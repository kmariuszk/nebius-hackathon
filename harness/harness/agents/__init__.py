"""One folder per agent, laid out the way `adk web` and `adk run` expect.

    harness/agents/<name>/__init__.py   from . import agent
    harness/agents/<name>/agent.py      build() and root_agent = build()

`build()` returns a fresh agent; a parent agent calls it to use this agent as
a sub-agent or an `AgentTool`. `root_agent` is what the ADK dev tools load.
"""
