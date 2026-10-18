"""Google ADK agents for the paper discovery canvas.

Shared building blocks live here: `settings` reads the environment,
`models` gives each job its Nemotron model on Token Factory, and `toolsets`
connects agents to the MCP servers. Each agent is a folder under
`harness/agents/` with an `agent.py` that defines `build()` and `root_agent`.
"""
