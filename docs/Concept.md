# Paper Discovery Canvas: Idea, System Design and Protocols

Oct 18, 2026 · @g

## Overview

We are building a paper discovery canvas for the Research Paper Discovery track: seed papers go in, and ranked, explained new papers come out on a shared tldraw canvas where a research team and an agent work together.

**The problem.** Researchers already hold a collection of relevant papers, but keyword search misses related work. The brief asks for a ranked list of new papers with metadata, source links and relevance explanations, deployed on Nebius.

**What makes our version different:**

- **A canvas, not a list.** Papers become cards linked by citations, sized by link count and coloured by rating, with the researchers' notes beside them.
- **A board the whole team shares.** Several researchers work on one live board, with cursors, shared notes, collaborative keep or discard triage, and an agent that works for all of them.
- **Evidence a judge can click.** Every explanation carries an abstract quote verified by exact match, the citation links that tie it to the seeds and, where possible, a real figure chosen by Nemotron 3.5 Super VL.
- **Our own harness on Google ADK, behind ACP.** The UI speaks ACP and every capability sits behind MCP, so the agent can be replaced without touching the UI.
- **Its own MCP server.** Researchers can work with the board from Claude, Cursor or their own agent.

**Track decision.** We are not entering the Britannica vs Wikipedia track, so Hermes and the self-hosted embedding and rerank containers are out. We keep its NVIDIA models where they add value (see NVIDIA model routing) and build our own harness on Google ADK.

**Track requirements:** Token Factory for LLM inference and embeddings; the app deployed on Nebius and hosted separately from the model endpoint; Tavily optional. Source board: [Miro mindmap and wireframes](https://miro.com/app/board/uXjVEY7-bbE=/).

## Product scope

The demo path is seed upload, a discovery run, the shared canvas, triage and chat; everything else on the board is faked or cut.

**User flows (rows on the Miro board):**

1. **Onboarding with seed papers (main path, Frames 13, 15, 14).** The researcher enters a question, drops seed PDFs or DOIs with rough context, and the agent starts shaping the board.
2. **Onboarding with a question only (Frames 4, 5).** A cold start: the app shows 8 to 10 search hits, the researcher picks 3 to 5 as seeds, and the main path continues.
3. **New paper (Frames 1 to 3).** A "New" card appears linked into its cluster. Its panel shows a project-specific summary, verified quotes, link and abstract, why it matters, its connected nodes and cluster, a relevant figure, and Keep or Discard.
4. **Recurring user (Frames 11, 12).** "Your projects" lists new papers per board. Clicking opens a one-at-a-time triage queue: Keep puts the paper on the canvas, Discard hides it.
5. **Toggling chat (Frames 7, 8).** The chat panel slides in on the right with the agent's plan, tool cards and approval prompts.
6. **Working together.** A researcher invites colleagues by link. Everyone sees cursors, notes and triage votes live, and anyone can ask the agent for a run.

**Feature triage:**

| Feature | Decision | How |
| --- | --- | --- |
| Onboarding with seed papers (PDF or DOI) | Build | OpenAlex resolves DOIs; Nemotron Parse reads PDFs and their bibliographies |
| Question-only onboarding | Build | Cold start: the user picks 3 to 5 seeds from search hits |
| Candidate discovery | Build | OpenAlex papers citing or sharing references with 2+ seeds; Semantic Scholar recommendations; Tavily for recent work |
| Ranking + explanations | Build | Embedding and citation-overlap score, Lightning verdicts, Super VL listwise rerank, quote checked by exact match |
| Canvas graph | Build | Node size = link count, colour = rating; server-side layout |
| Paper panel with connections and figure | Build | Connected nodes and cluster as evidence; Parse crops figures, Super VL picks one |
| Keep or discard triage | Build | Keep adds a seed; Discard adds a negative signal |
| Shared board with live cursors | Build | One tldraw sync room per board |
| Invite link, attribution, activity feed | Build | Shows who added, kept or discarded what, the agent included |
| Chat panel | Build | ACP client in the browser |
| Own MCP server | Build | The same tools our agent uses |
| Daily recommender and project dashboard | Fake | Same pipeline with a "published in the last N days" filter behind a re-run button |
| Login | Fake | Display name plus invite link; real accounts later |
| @agent in paper comments | Stretch | A comment thread starts a run scoped to that paper |
| Papers arguing against a thesis | Stretch | LLM classifies citation contexts; verify that Semantic Scholar exposes them |
| Roles and private notes | Cut | Everyone on a board is an editor for the demo |
| LinkedIn and X scraping | Cut | Terms-of-service risk; Tavily covers recent work |
| Paper editing through MCP | Cut | Weeks of work; see Later work |
| "Future work" chaining | Cut | Unreliable on abstracts alone |
| Agent rearranging nodes | Cut | People drag cards; the agent only places new ones |

**Answers to the board's open questions:**

- **Separate agents for cold start and daily updates?** No. One pipeline; only the date window and the seed set (board contents plus the discarded list) change.
- **Is the agent reused when a researcher adds a paper they found?** Yes. The added paper becomes a seed and the same pipeline runs around it.
- **Ranking agent or algorithm?** An algorithm for recall and scoring; the LLM only reranks the top results and explains them.
- **Save (Tinder-like) or just delete?** Both. Keep turns a paper into a seed and Discard is a negative signal. On a shared board each researcher's vote shows, and split votes mark the paper "contested".
- **A relevant picture on each card?** Yes, but only a real figure from the paper chosen by Super VL, never a generated image.
- **Paper placement agent?** It chooses a cluster or a neighbour; coordinates come from the layout service, because LLMs place things poorly.
- **Rewritten abstracts?** Fine as a TL;DR labelled as generated, always shown next to the original abstract and the verified quote.
- **Can users edit placement and links?** Yes, by hand. The agent never moves a card a person has moved.

## System architecture

The system has five parts: researcher browsers, a Node board service that owns each shared board, our ADK agent harness, a Python discovery service, and external model and data APIs.

&#91;embedded content: system architecture · shared boards, board service, ADK harness, discovery service\]

Every change to a board, from a person or an agent, lands in the board's sync room, so all researchers see it live and agents can work even when no browser is open.

**Components:**

| Component | Runs as | Responsibility | Tech |
| --- | --- | --- | --- |
| Web app | Static React bundle | Canvas, chat panel, triage inbox, paper panel | tldraw SDK, `@tldraw/sync`, ACP TypeScript SDK |
| Board service | Node, one long-lived Nebius Serverless Endpoint | Sync rooms, canvas MCP, ACP pipe, REST API, invites, activity feed | `TLSocketRoom` with SQLite storage, MCP TypeScript SDK, `ws` |
| Agent harness | Python process per researcher session, spawned by the board service | Reasoning loop: master agent and sub-agents | Google ADK, `LiteLlm` to Token Factory, ACP Python SDK |
| Discovery service | Python, second Endpoint | Papers MCP, discovery pipeline, parallel scoring, figures, daily runs | MCP Python SDK, LanceDB, SQLite |
| Model APIs | External | LLMs, embeddings, PDF parsing | Token Factory, NVIDIA hosted API |
| Scholarly sources | External | Metadata, citations, recommendations, web pages | OpenAlex, Semantic Scholar, PubMed, Tavily |

**Data flow, seeds to shared canvas:**

1. A researcher submits a question and seeds. The browser creates the board over REST, then opens its sync room and an ACP session.
2. The harness resolves the seeds and finds candidates through the papers MCP.
3. The discovery service scores candidates with Lightning in parallel, verifies quotes and stores the verdicts; Super VL reranks the top \~100.
4. The harness calls `add_papers` and `link_papers` on the canvas MCP, which writes into the board's sync room; every connected browser receives the change.
5. Opening a paper fetches its full record over REST; figures come from Parse, and Super VL picks one.
6. Keep or Discard goes over REST, is recorded per researcher, and updates the card's status in the room.

**Canvas layout rules:**

- A layout service inside the board service places new cards next to the named neighbour or inside the named cluster, avoiding overlaps.
- Node size = number of links; colour = rating; badges mark new, kept and contested papers.
- Agents name a cluster or a neighbour (`near`), never coordinates.
- A card a person has moved is pinned; the agent never moves it again.

**Design choices:**

- **The sync room is the single source of truth for the canvas.** The canvas MCP writes into it on the server through the room's storage transaction (`updateStore` in older tldraw versions). There is no browser relay, and no dependence on anyone's tab being open.
- **Shared changes through MCP, per-viewer actions through ACP.** Adding papers changes the board for everyone. Focusing a card or opening a panel goes only to the requesting researcher's client, as an ACP extension notification.
- **One owner of agent logic.** We skip the tldraw agent starter kit's in-browser agent loop.
- **Two Endpoints.** The board service holds stateful WebSockets and agent processes; the discovery service holds stateless tools and scheduled runs. Models stay on Token Factory, separate from the app, as the brief requires.

## Collaboration on the board

A board is a shared workspace: everyone invited sees the same canvas live, every change is attributed, and the agent acts as one more participant that follows the team's decisions.

**Concepts:**

| Concept | What it is | Where it lives |
| --- | --- | --- |
| Board | One research project: question, seeds, canvas | `boards` table + one sync room |
| Member | A researcher on the board, with role owner, editor or viewer (everyone is an editor in the demo) | `members` |
| Invite | A link carrying a role and an expiry | `invites` |
| Paper card | A paper on the canvas with its status (new, kept, contested) and who added it | Sync room shape + `board_papers` |
| Vote | One researcher's Keep or Discard on one paper | `decisions` |
| Note | A sticky or comment with its author | Sync room shape, author in shape meta |
| Run | One agent job: who asked, scope, status, cost | `runs` |
| Event | One line of the activity feed | `events` |

**What researchers see together:**

- Live cursors and names, plus cards, links and notes as they change ([tldraw sync](https://tldraw.dev/sdk-features/collaboration)).
- The agent's work. Cards it is processing carry a "working" badge, and every run appears in the activity feed with who asked for it, e.g. "Agent added 12 papers, asked by Ana".
- Attribution on every card and note: added by a person, or by the agent on behalf of a person, with the run ID.

**Collaborative triage:**

- Each researcher votes Keep or Discard on new papers. Votes are per person and show as avatars on the card.
- Status follows the votes: any Keep puts the paper on the canvas as kept; only Discards hide it and record a negative signal; Keep and Discard together mark it "contested" for discussion.
- Seeds and negatives belong to the board, so each member's decisions steer the next run for the whole team.

**Talking to the agent together:**

- Each researcher has their own chat: one ACP session per researcher per board. Conversations stay private; their effects on the board are shared.
- Anyone can start a run. Runs that only add things (papers, links, notes) run at the same time.
- Runs that rearrange or remove things take a per-board lease. A second one waits, and its chat shows "queued behind Ana's run".
- Stretch: "@agent" in a comment thread on a card starts a run scoped to that paper, and the agent replies in the thread.

**Rules when people and agents edit at once:**

- **People win.** tldraw sync is server-authoritative with rebase, not a CRDT, so concurrent edits merge record by record; the agent only touches its own cards and fields.
- **Human-touched cards are locked.** A card a person moved, edited or pinned is never moved by the agent.
- **The agent proposes, people decide.** It never deletes a person's card or note, and never votes.
- **Every agent write is traceable.** It carries `meta.createdBy = "agent"`, `meta.onBehalfOf` (the member ID) and `meta.runId`, so a whole run can be reviewed or undone.

**Access for the demo:**

- A display name plus an invite link with a signed token. Roles are stored but not enforced.
- Each researcher gets one board-scoped token. The browser passes it to the agent's MCP connections, so agent writes are attributed to the right person.
- Later: real accounts (ORCID or Google sign-in), enforced roles, private notes and notification settings.

## Agent design

The harness is built on Google ADK and owns only the reasoning loop; search, scoring, figures and board edits live behind MCP, so another agent could replace it without losing features.

**ADK agents and their models:**

| Agent | Model | Job | Main tools |
| --- | --- | --- | --- |
| `master` | Nemotron 3.5 Super VL | Plans the run, talks to the researcher, decides when the evidence is enough, places results | Canvas MCP, papers MCP |
| `search` | Nemotron 3.5 Lightning | Expands seeds into candidates | `find_candidates`, `search` |
| `figures` | Nemotron 3.5 Super VL | Picks and describes the figure that best supports relevance | `get_figures`, `pick_figure` |
| Bulk scoring (a tool, not an agent) | Nemotron 3.5 Lightning | Verdict, TL;DR and verified quote for hundreds of candidates | `score_candidates`, run in parallel inside the discovery service |

Bulk scoring is a tool because an LLM looping over 300 papers is slow and costly. `score_candidates` sends one Lightning request per paper in parallel, stores every verdict and returns only the top results to `master`.

```python
import os
from google.adk.agents import LlmAgent
from google.adk.models.lite_llm import LiteLlm
from google.adk.tools.mcp_tool import McpToolset
from google.adk.tools.mcp_tool.mcp_session_manager import StreamableHTTPConnectionParams

TF = dict(api_base="https://api.tokenfactory.nebius.com/v1/", api_key=os.environ["TF_API_KEY"])
super_vl = LiteLlm(model="openai/nvidia/Nemotron-3.5-Super-VL", **TF)
lightning = LiteLlm(model="openai/nvidia/Nemotron-3_5-Lightning", **TF)


def build_agent(canvas_url: str, papers_url: str, token: str) -> LlmAgent:
    auth = {"Authorization": f"Bearer {token}"}
    canvas = McpToolset(connection_params=StreamableHTTPConnectionParams(url=canvas_url, headers=auth))
    papers = McpToolset(connection_params=StreamableHTTPConnectionParams(url=papers_url, headers=auth))
    search = LlmAgent(name="search", model=lightning, tools=[papers],
                      instruction="Expand the seeds into candidate papers.")
    figures = LlmAgent(name="figures", model=super_vl, tools=[papers],
                       instruction="Pick the figure that best supports relevance.")
    return LlmAgent(name="master", model=super_vl, tools=[canvas, papers],
                    sub_agents=[search, figures],
                    instruction="Plan the discovery run, score candidates, then place verified results on the canvas.")
```

`build_agent` runs once per ACP session: the canvas URL and the researcher's board token come from that session's `mcpServers`, so every write is attributed to the right person. The `openai/` prefix tells LiteLLM to treat Token Factory as an OpenAI-compatible endpoint.

**Discovery and ranking pipeline:**

1. **Resolve seeds** (`resolve_seed`). A DOI becomes an OpenAlex record; a PDF goes through Nemotron Parse for title, DOI and bibliography.
2. **Generate candidates** (`find_candidates`). OpenAlex papers that cite 2+ seeds or share references with them, Semantic Scholar recommendations, and Tavily for recent preprints.
3. **Deduplicate.** Drop seeds and the board's discarded papers, first by DOI, then by normalised title.
4. **Score** (`score_candidates`). Embedding similarity to the question and seeds, citation overlap and recency, then a Lightning JSON verdict per candidate.
5. **Verify.** The quote must appear verbatim in the abstract; otherwise the explanation is flagged "unverified".
6. **Rerank** (`rerank`). Super VL ranks the top \~100 listwise with all seed abstracts in context.
7. **Place** (`add_papers`, `link_papers`). The top results go onto the canvas, and the layout service positions them.
8. **On open** (`get_figures`, `pick_figure`). Parse extracts figures and Super VL picks the one that best supports relevance.

**Memory.** Per board: seeds, kept and discarded papers, verdicts and embeddings, in the discovery service (LanceDB and SQLite). Per researcher: their chat history, in the ADK session. Discarded papers are a negative signal for every later run, whoever discarded them.

## Protocols

Three protocols each do one job: tldraw sync keeps the shared canvas consistent, ACP carries each researcher's conversation with the agent, and MCP carries every capability. REST covers everything that isn't live.

| Protocol | Between | Carries | Transport |
| --- | --- | --- | --- |
| tldraw sync | Browsers and the board service | Canvas records and presence for one board | WebSocket `/sync/{boardId}` |
| ACP | Browser chat and the agent harness | One researcher's session: prompts, streamed updates, approvals, cancel | WebSocket `/acp`, piped to stdio |
| MCP | Our harness or an external agent, and the two MCP servers | Tool calls | Streamable HTTP |
| REST + SSE | Browser and the board service | Boards, invites, triage, paper records, activity feed | HTTPS; SSE for the feed |

### tldraw sync: the shared canvas

- **One `TLSocketRoom` per board** in the board service, persisted with SQLite storage.
- **Server-authoritative.** Clients push diffs; the server commits or rebases them and broadcasts patches to everyone else. Presence (cursors, names, selection) rides the same socket.
- **Agent writes go in server-side.** The canvas MCP writes through the room's storage transaction (`updateStore` in older tldraw versions), so agent changes reach every client exactly like a person's.
- **Browser side:** the `useSync` hook connects to the board's `/sync/{boardId}` URL with a ticket.
- **Custom shapes** (`paper-card`, `cluster`) are registered in both the server schema and the client.

### ACP: one researcher's conversation

1. **`initialize`.** The client declares no `fs` or `terminal` capabilities. The agent declares HTTP MCP support plus image and embedded-context prompts.
2. **`session/new`.** The client sends `cwd` and `mcpServers`: the board's canvas MCP and the papers MCP, each with the researcher's board token as an `Authorization` header.
3. **`session/prompt`.** User text, the selected paper cards as embedded `resource` blocks, and a viewport screenshot as an `image` block.
4. **`session/update` stream.** Plan, tool calls, thoughts and message chunks; `session/request_permission` before bulk or destructive changes.
5. **Prompt response.** A stop reason such as `end_turn` or `cancelled`.
6. **`session/cancel`.** Sent when the researcher presses Stop.

**How ADK events become ACP updates:**

| ADK event | ACP update | Chat panel shows |
| --- | --- | --- |
| Text from `master` | `agent_message_chunk` | Normal message |
| Part marked as a thought | `agent_thought_chunk` | Dimmed text |
| Plan the master writes as structured output | `plan` | A checklist that ticks off |
| Function call (`event.author` names the sub-agent) | `tool_call`, e.g. "search: find\_candidates" | Collapsible card |
| Function response | `tool_call_update`, completed or failed | The card's result |
| Tool confirmation request | `session/request_permission` | Approve and deny buttons |
| Per-viewer action | Extension notification `_canvas/focus` or `_canvas/open_paper` | That researcher's view moves; nobody else's does |

**Board service: the ACP pipe.** It checks a short-lived ticket, spawns one harness per session and forwards lines both ways.

```javascript
import { spawn } from "node:child_process";
import readline from "node:readline";
import { WebSocketServer } from "ws";
import { redeemTicket } from "./auth.js";

const wss = new WebSocketServer({ noServer: true });

export function handleAcpUpgrade(req, socket, head) {
  const ticket = new URL(req.url, "http://localhost").searchParams.get("ticket");
  const claims = redeemTicket(ticket);
  if (!claims) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    const child = spawn("python", ["-m", "harness"], {
      env: { ...process.env, BOARD_ID: claims.boardId, MEMBER_ID: claims.memberId },
      stdio: ["pipe", "pipe", "inherit"],
    });
    readline.createInterface({ input: child.stdout }).on("line", (line) => ws.send(line));
    ws.on("message", (msg) => child.stdin.write(msg.toString() + "\n"));
    ws.on("close", () => child.kill());
    child.on("exit", () => ws.close());
  });
}
```

**Browser: the ACP client.** The TypeScript SDK (`@agentclientprotocol/sdk`) accepts any stream with a readable and a writable side, so the WebSocket is wrapped directly.

```typescript
import { ClientSideConnection, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const ws = new WebSocket(`${BOARD_WS}/acp?ticket=${ticket}`);
await new Promise((resolve) => (ws.onopen = resolve));

const stream = {
  readable: new ReadableStream({
    start(controller) {
      ws.onmessage = (e) => controller.enqueue(JSON.parse(e.data));
      ws.onclose = () => controller.close();
    },
  }),
  writable: new WritableStream({ write: (message) => ws.send(JSON.stringify(message)) }),
};

const conn = new ClientSideConnection(
  () => ({
    sessionUpdate: async ({ update }) => renderUpdate(update),
    requestPermission: async (params) => askUserInPanel(params),
    extNotification: async (method, params) => handleViewerAction(method, params),
  }),
  stream,
);

const auth = [{ name: "Authorization", value: `Bearer ${boardToken}` }];
await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
const { sessionId } = await conn.newSession({
  cwd: "/",
  mcpServers: [
    { type: "http", name: "canvas", url: `${BOARD_API}/mcp/canvas/${boardId}`, headers: auth },
    { type: "http", name: "papers", url: `${DISCOVERY_API}/mcp`, headers: auth },
  ],
});
```

**Harness: ADK behind ACP.** ADK speaks A2A natively, not ACP, so this adapter is ours. It builds one ADK runner per ACP session and turns ADK events into ACP updates.

```python
import asyncio
import os
from typing import Any
from uuid import uuid4

from acp import PROTOCOL_VERSION, Agent, InitializeResponse, NewSessionResponse, PromptResponse, run_agent
from acp.interfaces import Client
from acp.schema import AgentCapabilities, Implementation, McpCapabilities, PromptCapabilities
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService

from harness.agents import build_agent
from harness.mapping import mcp_config, to_acp_updates, to_genai_content

APP, MEMBER = "paper-discovery", os.environ.get("MEMBER_ID", "member")


class PaperHarness(Agent):
    def on_connect(self, conn: Client) -> None:
        self._conn = conn
        self._sessions: dict[str, dict[str, Any]] = {}
        self._store = InMemorySessionService()

    async def initialize(self, protocol_version: int, **kwargs: Any) -> InitializeResponse:
        return InitializeResponse(
            protocol_version=PROTOCOL_VERSION,
            agent_capabilities=AgentCapabilities(
                mcp_capabilities=McpCapabilities(http=True),
                prompt_capabilities=PromptCapabilities(image=True, embedded_context=True),
            ),
            agent_info=Implementation(name="paper-harness", title="Paper Harness", version="0.1.0"),
        )

    async def new_session(self, cwd: str, mcp_servers=None, **kwargs: Any) -> NewSessionResponse:
        canvas_url, papers_url, token = mcp_config(mcp_servers or [])
        runner = Runner(agent=build_agent(canvas_url, papers_url, token), app_name=APP, session_service=self._store)
        adk_session = await self._store.create_session(app_name=APP, user_id=MEMBER)
        session_id = uuid4().hex
        self._sessions[session_id] = {"runner": runner, "adk_id": adk_session.id, "task": None}
        return NewSessionResponse(session_id=session_id)

    async def prompt(self, session_id: str, prompt: list, **kwargs: Any) -> PromptResponse:
        s = self._sessions[session_id]
        s["task"] = asyncio.current_task()
        try:
            events = s["runner"].run_async(user_id=MEMBER, session_id=s["adk_id"], new_message=to_genai_content(prompt))
            async for event in events:
                for update in to_acp_updates(event):
                    await self._conn.session_update(session_id=session_id, update=update)
        except asyncio.CancelledError:
            return PromptResponse(stop_reason="cancelled")
        return PromptResponse(stop_reason="end_turn")

    async def cancel(self, session_id: str, **kwargs: Any) -> None:
        task = self._sessions[session_id]["task"]
        if task:
            task.cancel()


if __name__ == "__main__":
    asyncio.run(run_agent(PaperHarness()))
```

`to_acp_updates` implements the mapping table above; `mcp_config` reads the two MCP URLs and the token from what the client sent. Check capability field names against the ACP SDK's `examples/agent.py`.

### MCP: every capability

- **Two servers.** The canvas MCP lives in the board service at a board-scoped URL (`/mcp/canvas/{boardId}`); the papers MCP lives in the discovery service (`/mcp`). Both use streamable HTTP with the researcher's board token as a bearer token.
- **Shared changes only through the canvas MCP.** Per-viewer actions (focus, open a panel) go through ACP extension notifications instead.
- **External agents use the same servers.** A researcher creates a personal token in board settings and adds both URLs to Claude, Cursor or another MCP client.
- **Tool contracts** are in APIs and data model.

### Protocol gotchas

- **Not every agent honours `mcpServers`.** Cursor's ACP agent advertises HTTP MCP but silently ignores servers passed in `session/new` ([report](https://forum.cursor.com/t/acp-agent-silently-ignores-mcpservers-in-session-new/153623)). Our harness reads them; for external agents the researcher configures the URLs.
- **HTTP MCP is opt-in.** Agents declare it in `initialize`, so our harness must set it.
- **One MCP connection per session, in its own long-lived task.** The Python MCP client fails when opened in one task and closed in another.
- **WebSocket auth uses short-lived tickets.** Browsers can't set headers on WebSockets, so the URL carries a one-minute ticket from REST, never the long-lived token.
- **Future option.** The [MCP-over-ACP proposal](https://agentclientprotocol.com/rfds/mcp-over-acp.md) would let the client host MCP servers over the ACP channel itself. It is still a proposal.

## APIs and data model

The board service exposes REST, three realtime channels and the canvas MCP; the discovery service exposes the papers MCP. Every call is scoped to one board and authenticated with the researcher's board token.

**Conventions:** base path `/api/v1`; bearer board token; JSON errors as `{"error": {"code", "message"}}`; idempotent writes keyed on board and paper; ISO 8601 UTC timestamps; prefixed IDs (`b_`, `m_`, `run_`).

### REST API (board service)

| Method | Path | Purpose | Request → response |
| --- | --- | --- | --- |
| POST | `/boards` | Create a board | `{title, question, context}` → `Board` |
| GET | `/boards` | Boards the caller belongs to, with inbox counts | → `[Board]` |
| GET | `/boards/{id}` | Board details, members and seeds | → `Board` |
| POST | `/boards/{id}/invites` | Create an invite link | `{role, expiresInHours}` → `{url}` |
| POST | `/invites/{token}/accept` | Join a board | `{displayName}` → `{member, boardToken}` |
| POST | `/boards/{id}/seeds` | Add a seed by DOI or PDF upload | `{doi}` or multipart PDF → `Paper` |
| POST | `/boards/{id}/runs` | Start a run without chat (onboarding, daily, around one paper) | `{kind, paperId?}` → `Run` |
| GET | `/boards/{id}/runs/{runId}` | Run status and counts | → `Run` |
| DELETE | `/boards/{id}/runs/{runId}` | Cancel a run | → 204 |
| GET | `/boards/{id}/inbox` | New papers waiting for the caller's vote | `?status=pending` → `[PaperCard]` |
| PUT | `/boards/{id}/papers/{paperId}/vote` | Keep or Discard | `{decision}` → `{status, votes}` |
| GET | `/boards/{id}/papers/{paperId}` | Full record for the paper panel | → `Paper` |
| GET | `/boards/{id}/activity` | Activity feed, newest first | `?after={seq}` → `[Event]` |
| POST | `/boards/{id}/ws-tickets` | One-minute ticket for the sync and ACP sockets | → `{ticket}` |
| GET | `/boards/{id}/export.bib` | Kept papers as BibTeX | → text |

Runs started over REST use a headless harness session, so onboarding and daily runs follow the same path as chat runs and report into the activity feed.

### Realtime channels

| Channel | Path | Direction | Payload |
| --- | --- | --- | --- |
| Sync | `/sync/{boardId}?ticket=…` (WebSocket) | Both ways | tldraw sync protocol: diffs, patches, presence |
| ACP | `/acp?ticket=…` (WebSocket) | Both ways | ACP JSON-RPC, one message per line |
| Activity | `/api/v1/boards/{id}/events` (SSE) | Server to browser | `Event` objects as they happen |

### Canvas MCP tools (board service, `/mcp/canvas/{boardId}`)

| Tool | Input | Output | Notes |
| --- | --- | --- | --- |
| `get_board` | none | `{question, seeds, papers, clusters, discardedIds}` | A compact summary, never raw shapes |
| `add_papers` | `{papers: [{paperId, near, rating, reason}], runId}` | `{added, skipped}` | Append-only; the layout service places cards |
| `link_papers` | `{from, to, relation}` | `{linkId}` | Relation: cites, cited\_by, similar, contradicts or extends |
| `set_rating` | `{paperId, score, verdict}` | `{ok}` | Score 0 to 1; sets the card colour |
| `add_note` | `{text, paperId}` | `{noteId}` | Authored as the agent on behalf of the member |
| `create_cluster` | `{label, paperIds}` | `{clusterId}` | Takes the board lease |
| `mark_working` | `{paperIds, on}` | `{ok}` | The "working" badge everyone sees |

There is no selection tool and no vote tool: selection is per viewer and arrives in the prompt, and only people keep or discard.

### Papers MCP tools (discovery service, `/mcp`)

| Tool | Input | Output |
| --- | --- | --- |
| `resolve_seed` | `{doi, pdfUrl, title}` (any one) | `Paper` |
| `find_candidates` | `{boardId, seedIds, excludeIds, strategies, since, limit}` | `{candidateIds, countsByStrategy}` |
| `score_candidates` | `{boardId, candidateIds}` | `{top, scored, unverified}` |
| `rerank` | `{boardId, paperIds, k}` | `{ranked}` |
| `search` | `{query, limit}` | `[PaperSummary]` |
| `get_paper` | `{paperId}` | `Paper` |
| `get_figures` | `{paperId}` | `[{figureId, caption, imageUrl, page, bbox}]` |
| `pick_figure` | `{boardId, paperId}` | `{figureId, why}` |

`strategies` is any of citing, coupling, recommend and web. The harness passes `excludeIds` from `get_board`, so the discovery service never needs the board's votes directly.

### Paper record

```json
{
  "paperId": "openalex:W…",
  "ids": { "doi": "10.1038/s41586-021-03704-y", "pmid": "…", "openalex": "W…" },
  "title": "…",
  "authors": ["…"],
  "year": 2021,
  "venue": "Nature",
  "url": "https://doi.org/10.1038/s41586-021-03704-y",
  "abstract": "…",
  "openAccessPdf": "https://…",
  "relevance": {
    "score": 0.82,
    "verdict": "relevant",
    "reason": "…",
    "quote": "…",
    "quoteVerified": true,
    "figure": { "figureId": "fig3", "caption": "…", "imageUrl": "…", "why": "…" },
    "model": "nvidia/Nemotron-3_5-Lightning",
    "runId": "run_…"
  },
  "connections": { "citesSeeds": ["…"], "citedBySeeds": [], "sharedReferences": 7, "cluster": "…" },
  "foundBy": ["coupling", "recommend"],
  "board": {
    "status": "contested",
    "votes": { "keep": ["m_…"], "discard": ["m_…"] },
    "addedBy": "agent",
    "onBehalfOf": "m_…"
  }
}
```

### Canvas shapes

| Shape | Props | Meta |
| --- | --- | --- |
| `paper-card` (custom) | `paperId`, `title`, `year`, `rating`, `status`, `w`, `h` | `createdBy`, `onBehalfOf`, `runId`, `pinnedByHuman` |
| Arrow (built-in, bound to two cards) | Start and end bindings | `relation`, `createdBy` |
| Note (built-in) | Rich text | `author` |
| `cluster` (frame) | `label` | `createdBy` |

### Storage

| Table | Key columns | Owner |
| --- | --- | --- |
| `boards` | `id`, `title`, `question`, `context`, `created_by` | Board service |
| `members` | `board_id`, `member_id`, `display_name`, `role` | Board service |
| `invites` | `token`, `board_id`, `role`, `expires_at` | Board service |
| `board_papers` | `board_id`, `paper_id`, `status`, `rating`, `cluster`, `added_by`, `run_id` | Board service |
| `decisions` | `board_id`, `paper_id`, `member_id`, `decision`, `at` | Board service |
| `runs` | `id`, `board_id`, `requested_by`, `kind`, `status`, `started_at`, `tokens_used` | Board service |
| `events` | `seq`, `board_id`, `actor`, `type`, `payload` | Board service |
| `papers` | `paper_id`, `doi`, `pmid`, `title`, `authors`, `year`, `abstract` | Discovery service |
| `verdicts` | `board_id`, `paper_id`, `score`, `verdict`, `reason`, `quote`, `quote_verified`, `model`, `run_id` | Discovery service |
| `figures` | `paper_id`, `figure_id`, `caption`, `image_path`, `page`, `bbox` | Discovery service |
| `paper_vectors` (LanceDB) | `paper_id`, `vector`, `text` | Discovery service |

The board service owns everything about the board and its people; the discovery service owns everything about papers. Each runs on its own SQLite, so the two Endpoints share no database.

## NVIDIA model routing

Each job goes to the Nemotron model built for it, and the routing is visible in the demo. Hard planning goes to a large reasoning model, repetitive execution to Lightning, as NVIDIA itself positions them.

| Job | Model | Runs on |
| --- | --- | --- |
| Master agent: planning, chat, final listwise ranking | Nemotron 3.5 Super VL (`nvidia/Nemotron-3.5-Super-VL`) | Token Factory |
| Reading figures and pages, picking the relevant picture, reading the canvas screenshot | Nemotron 3.5 Super VL | Token Factory |
| Per-paper work on hundreds of candidates: verdict, TL;DR, quote, citation stance | Nemotron 3.5 Lightning (`nvidia/Nemotron-3_5-Lightning`) | Token Factory |
| Seed PDF parsing, bibliography extraction, figure cropping | Nemotron Parse | NVIDIA hosted API |
| Optional rerank by text plus first-page image | Llama Nemotron Rerank VL 1B v2 | NVIDIA hosted API |
| Embeddings | A Nemotron embedding if Token Factory lists one, else Qwen3-Embedding-8B | Token Factory |

**Why these models:**

- **Super VL** (released 15 October 2026) is 120B total with 12B active, takes image and video input, and targets OCR, tables, charts and documents. Its 1M-token context fits all seed abstracts plus the top \~100 candidates in one listwise call.
- **Lightning** is 30B total with 3B active, distilled from Nemotron 3 Ultra for high-volume tool calls and result validation. It supports strict JSON output, so verdicts come back as clean data. The organisers' notebook already uses it.
- **Parse** labels titles, captions, tables, bibliography and pictures with bounding boxes and returns tables as LaTeX. It is available as a hosted endpoint, so no GPU is needed.

**Two showcase features:**

1. **Visual evidence a judge can click.** Parse finds a candidate's figures, we crop them by bounding box, and Super VL picks the one that supports relevance. The explanation cites the figure itself: "Fig. 3 shows CD8 T-cell clusters in metastatic sites", with the crop.
2. **Bibliographies from uploaded PDFs.** Parse extracts the reference list of seed PDFs directly, so the citation graph works even for preprints OpenAlex hasn't indexed yet.

**Requirement boundary.** Super VL, Lightning and embeddings stay on Token Factory, as the brief requires for LLM inference and embeddings. Parse and the reranker are neither, so NVIDIA's hosted API should be allowed; we confirm this with the organisers. Hosted and self-hosted Parse use different HTTP contracts.

**Held-out evaluation.** Take a recent review paper, use 5 of its references as seeds, and measure how many of its other references the pipeline recovers in the top 20. Compare three setups:

1. Embeddings only.
2. Embeddings plus Lightning verdicts.
3. Both plus Super VL listwise rerank.

Show judges one results table from this, each trace step labelled with its model, time and cost ("Lightning: scored N candidates in T s"), and the routing table above in the README.

**Skip:** self-deploying the Embed-VL and Rerank-VL containers (GPU work for a track we left), Nano Omni voice input and Content Safety. They don't fit the problem and would read as collecting logos.

## Requirements, risks and first-hour checklist

The biggest risks are plumbing nobody sees (WebSockets on Nebius, LiteLLM tool calling, the ACP pipe) and people and agents editing one board at once; each has a cheap first-hour check or a rule.

**Hard requirements (Paper Discovery):**

- LLM inference and embeddings on Nebius Token Factory.
- A working app deployed on Nebius, hosted separately from the model endpoint.
- Output: a ranked list of new papers with metadata, source links and relevance explanations.

| Risk | What breaks | Mitigation |
| --- | --- | --- |
| tldraw licence in production | Since SDK 4.0 the canvas needs a licence key outside development | Get the free 100-day trial key in the first hour; multiplayer sync is included in the SDK licence |
| WebSockets on Nebius Serverless | No sync and no ACP stream | Deploy a hello-world Endpoint with a WebSocket first; fallback to SSE plus POST for ACP |
| Nemotron tool calling through LiteLLM | Agents can't call tools | Test both models with one MCP tool in the first hour; pin ADK and LiteLLM versions once it works |
| People and agents editing at once | Cards jump or get overwritten | Agent appends only; human-touched cards locked; per-board lease for layout changes |
| Sync room persistence | A restart loses the board | SQLite storage on a mounted volume; snapshot each board when a run finishes |
| One harness per collaborator | Memory and token spend grow with the team | Close idle sessions after 10 minutes; queue headless runs |
| ACP plumbing effort | About half a day for one person | Keep the pipe dumb and reuse the SDKs; fallback is ADK's own API server with SSE |
| Parse latency | Slow paper panel | Run only on seed PDFs and opened papers; cache figures |
| NVIDIA hosted API for Parse and rerank | Requirement dispute | Confirm with the organisers in one message |
| Hallucinated explanations | A judge's click fails | Exact-match quote check; "unverified" flag |

**First-hour checklist:**

- [ ] Get the tldraw trial licence key
- [ ] Deploy a hello-world Endpoint on Nebius Serverless with a WebSocket and confirm it stays connected
- [ ] Run tool calling through ADK `LiteLlm` with Super VL and Lightning on Token Factory
- [ ] Stand up one `TLSocketRoom` with two browsers and one server-side write
- [ ] Confirm with the organisers that Parse and rerank via NVIDIA's hosted API are allowed
- [ ] Check the Token Factory catalogue for a Nemotron embedding model
- [ ] Run our seed papers through OpenAlex and check the candidate count

## Open questions and later work

**Open questions:**

- [ ] How many people and hours do we have? That sets how much of the Build list survives.
- [ ] Is there an NVIDIA side award, and what does it judge?
- [ ] Are pluggable agents part of the pitch? If not, ADK's own API server with SSE replaces the ACP layer and saves 2 to 3 hours.
- [ ] Does a Nebius Serverless Endpoint allow one harness process per session, and how much memory does each need?
- [ ] Triage policy: does one Keep put a paper on the canvas, or do we want a majority of the board?

**Later work:**

- **Paper editor inside tldraw.** A basic document shape takes days, a usable one weeks, and a collaborative editor with citations months. Two routes: TipTap rich text that exports to LaTeX, or a LaTeX-native CodeMirror shape with a compiled PDF preview (Tectonic or texlive in WASM). The hard parts are canvas event conflicts, text under zoom, long documents, paper semantics, and collaborative text editing, which needs Yjs alongside tldraw sync because tldraw merges per record.
- **Collaboration beyond the demo:** real accounts (ORCID or Google sign-in), enforced roles, private notes, @agent in comment threads, and notifications for new papers.
- **MCP-over-ACP** once it stabilises, so the client can host tools over the ACP channel.
- **Scholar-profile onboarding** and personal recommendation settings.
- **More sources,** such as Hugging Face papers and social media, once terms of service are checked.

## Sources

- [Research Paper Discovery notebook and brief](https://gzvqcrohgpzewcnfecrk.supabase.co/storage/v1/object/public/techeurope-assets/track-media/04cf15c6a046.ipynb)
- [Team Miro board](https://miro.com/app/board/uXjVEY7-bbE=/)
- [ACP session setup spec](https://agentclientprotocol.com/protocol/session-setup)
- [MCP-over-ACP proposal](https://agentclientprotocol.com/rfds/mcp-over-acp.md)
- [ACP Python SDK examples](https://github.com/agentclientprotocol/python-sdk/blob/main/examples/agent.py)
- [ACP TypeScript SDK streams](https://www.mintlify.com/agentclientprotocol/typescript-sdk/api/stream)
- [Cursor forum: ACP agent ignores mcpServers](https://forum.cursor.com/t/acp-agent-silently-ignores-mcpservers-in-session-new/153623)
- [Google ADK: Claude models (LiteLLM and Agent Platform)](https://adk.dev/agents/models/anthropic/)
- [Google ADK with an OpenAI-compatible endpoint via LiteLLM](https://docs.doubleword.ai/inference-api/integrations/google-adk)
- [Google ADK McpToolset over streamable HTTP](https://docs.nimbleway.com/integrations/connectors/google-adk.md)
- [ADK and ACP are different things](https://www.i-programmer.info/news/80-java/18806-google-agent-development-kit-for-java-10-released-published.html)
- [ADK and LiteLLM function-call regression report](https://github.com/google/adk-python/issues/4650)
- [tldraw sync (collaboration)](https://tldraw.dev/sdk-features/collaboration)
- [tldraw TLSocketRoom reference](https://tldraw.dev/reference/sync-core/TLSocketRoom)
- [tldraw release notes: pluggable storage replaces updateStore](https://tldraw.dev/llms-releases.txt)
- [tldraw sync architecture notes](https://grida.co/docs/wg/research/crdt/tldraw)
- [tldraw agent starter kit](https://tldraw.dev/starter-kits/agent)
- [tldraw SDK 4.0 licensing](https://appdevelopermagazine.com/tldraw-sdk-4.0-release-new-starter-kits-and-licensing-model/)
- [tldraw pricing (multiplayer sync included)](https://tldraw.dev/pricing)
- [tldraw rich text (TipTap)](https://tldraw.dev/sdk-features/rich-text)
- [Nemotron 3.5 Super VL announcement](https://www.hpcwire.com/aiwire/2026/10/15/nvidia-expands-nemotron-family-with-highest-efficiency-super-vl-and-bolt-models/)
- [Nemotron 3.5 Super VL on Nebius (model listing)](https://www.edenai.co/models/nemotron-3-5-super-vl)
- [Nemotron 3.5 Lightning](https://yourstory.com/ai-story/nvidia-nemotron-3-5-lightning-ai-agents)
- [Nemotron Parse model card](https://huggingface.co/nvidia/NVIDIA-Nemotron-Parse-v1.1)
- [Nemotron Parse on NVIDIA API catalog](https://docs.nvidia.com/nemotron/0.1.0/usage-cookbook/Nemotron-Parse-v1.1/README.html)
- [NeMo Retriever release notes (Parse contracts)](https://docs.nvidia.com/nemo/retriever/latest/extraction/releasenotes/index.html)
