# Paper Discovery Canvas: Idea, System Design and Protocols

Oct 18, 2026 · @g

## Overview

We are building a paper discovery canvas for the Research Paper Discovery track: seed papers go in, and ranked, explained new papers come out on a tldraw canvas, a "crazy board" of papers, quotes, figures and notes that the researcher and an agent build together.

**The problem.** Researchers already hold a collection of relevant papers, but keyword search misses related work, and the tools that exist are fragmented: a graph plugin in one place, a summariser in another, a plain list everywhere. The brief asks for a ranked list of new papers with metadata, source links and relevance explanations, deployed on Nebius.

**What makes our version different:**

- **A canvas, not a list.** Papers become cards linked by citations, sized by link count and coloured by rating, with quotes, figures and the researcher's notes beside them. Filters restructure the graph by citation, cluster or year.
- **You watch the agent build it.** Cards appear as soon as the agent is confident they are relevant, then fill in while reader agents summarise them. The research process is part of the demo.
- **Your reading becomes the agent's context.** Passages a researcher highlights in a paper become knowledge nodes on the board, and the agent sees them along with sticky notes and the current selection.
- **Evidence a judge can click.** Every explanation carries a quote verified by exact match against the abstract or the full text, the citation links that tie it to the seeds and, where possible, a real figure chosen by Nemotron 3.5 Super VL.
- **"Catch me up."** Back on a board after a while, the researcher asks the agent what changed and it walks them through it, zooming in on each new paper and back out. No video, just the board.
- **MCP first, with our own harness.** Every board capability is an MCP tool, so the same board works from our Google ADK harness (behind ACP) and from Claude, Cursor or a researcher's own agent.

**Multiplayer is a supporting feature.** The client is already the tldraw Multiplayer starter, so a board can be shared by link and a team can work on it live. The team agreed it has no wow factor on its own, so the pitch mentions it rather than leads with it.

**What we are entering.** One tool for researchers, entered in two challenges. We use NVIDIA's Nemotron models wherever they do a real job (see NVIDIA model routing), store paper embeddings in LanceDB, and build our own harness on Google ADK.

| | Research Paper Discovery (Pre-GTC HCLS hackathon) | Agentic Deep Research with Token Factory and Tavily |
| --- | --- | --- |
| Fit | The task itself | Its listed direction "literature or market scans that start from a seed set and find what's missing" |
| Must use | Token Factory for embeddings and LLM inference; Tavily for agentic search | Token Factory for primary inference; Tavily for all web retrieval |
| Deliver | A working app deployed on Nebius (the organisers' notebook says Nebius Serverless), hosted separately from the model endpoint; a ranked list of new papers with metadata, source links and relevance explanations | A public GitHub repo with a README a judge can run from; a 2-minute demo video on the hackathon platform by 18:30 |
| Judged on | — | Originality, creativity, use of the tools and presentation. In practice: a judge clicks three citations at random and they hold up; the demo shows one complete run with no cuts around the hard part; the trace shows the agent making decisions, not following a script |

What the Tavily challenge's judging means for us:

- **Every citation must survive a random click.** Quotes are checked by exact match, and each source link carries a text fragment (`…/PMC9187974/#:~:text=<quote>`), so the click lands on the highlighted sentence.
- **One complete run fits in the video.** A discovery run has to place its first cards within a minute and finish within about 90 seconds; the Nebius cookbook's sample run made 6 model calls in under 90 seconds.
- **The trace is part of the demo.** The chat panel shows the master's plan, each search and read, and its decision that the evidence is enough; this is why the design is agent-first.
- **Tavily sits in the core loop**, not on the side: it finds papers and reads them (see Search sources).

**Side awards.** Best use of Nemotron, which we target by giving each job its own Nemotron model; Reflection AI credits for projects that use Beam on Token Factory (optional, for example for a fact-checker that tries to break each explanation); and a Hugging Face side challenge (most likes one week after the hackathon), which is not a focus.

**Source board:** [Miro mindmap and wireframes](https://miro.com/app/board/uXjVEY7-bbE=/).

## Product scope

The demo path is seed upload, a discovery run that fills the board live, the paper overlay with highlights and quotes, chat that points at cards, and the catch-me-up tour; everything else is faked or cut. The whole product is one board: new papers, triage and notes all happen there, not on separate screens.

**User flows (rows on the Miro board):**

1. **Onboarding with seed papers (main path, Frames 13, 15, 14).** The researcher enters a question or a free-text topic, drops seed PDFs or DOIs with rough context, and the agent starts shaping the board.
2. **Onboarding with a question only (Frames 4, 5).** A cold start: the app shows 8 to 10 search hits, the researcher picks 3 to 5 as seeds, and the main path continues.
3. **New paper (Frames 1 to 3; [clickable mockup](mockups/paper-panel.html)).** A "New" card appears linked into its cluster as soon as the agent is confident it is relevant, with a "working" badge while a reader agent summarises it. Clicking the card zooms in and opens the paper overlay on top of the canvas (not a split screen). The overlay follows the mockup's order, which follows the keep-or-discard decision:
   1. **What it is:** title, authors, venue, year, DOI, PubMed and PDF links, paper type.
   2. **Why it matters:** one or two AI-written sentences, each claim numbered to its evidence, plus a relation tag such as "Same disease · adds a spatial method".
   3. **Evidence from the paper:** verbatim quotes marked "exact match" or "not found", each opening its source with the quote highlighted; the seeds it cites; a real figure, or its links on the board when there is no open-access PDF.
   4. **Couldn't check:** what the agent couldn't assess.
   5. **On this board:** cluster, links, closest paper in the collection, and how it was found.
   6. **The paper itself:** the PDF with everyone's highlights and annotations, the AI summary next to the original abstract, and notes.
   7. **Pinned buttons:** Discard, Ask agent (opens chat with this paper as context), Dig deeper (a run around this paper) and Keep.

   Text taken from the paper is set in serif and links to its source; AI-written text carries an "AI" tag with its model and time.
4. **Recurring user (Frames 11, 12).** "Your projects" lists the boards with a count of new papers. On a board the new papers are already placed in context; "Catch me up" has the agent zoom in on each one in turn, explain it and zoom back out, and the researcher keeps or discards it on the spot.
5. **Reading, highlighting and annotating together.** Clicking any paper node opens the paper in the overlay. The researcher highlights passages and annotates them with a note, and both appear live for every collaborator: in the PDF, colour-coded and labelled with the author's name, and on the board. The agent categorises each highlight (method, dataset, result and so on), the category sets its colour, and the highlight becomes a knowledge node on the board linked to its paper. Collaborators can reply to an annotation. Later agents work from these nodes, not from the whole paper.
6. **Toggling chat (Frames 7, 8).** The chat panel slides in on the right with the agent's plan, tool cards and approval prompts. Papers the agent mentions are clickable and zoom the canvas to their card; when it answers a question, the cards behind the answer are highlighted on that researcher's screen.
7. **Ranked list.** A list view beside the canvas shows the new papers ranked, with metadata, source link and relevance explanation, as the brief asks. Clicking a row zooms to the card.
8. **Working together.** A researcher invites colleagues by link. Everyone sees cursors, notes and triage votes live, and anyone can ask the agent for a run.

**Demo plan.** Start from a question and seeds and let the judges watch the board build itself. Open a paper, highlight a passage and show the node it creates, then ask the chat a question and watch the cards light up. Finally switch to a board prepared half an hour earlier, press "Catch me up", and let the agent tour the papers it found in the meantime: a researcher that is always working for you.

**Feature triage:**

| Feature | Decision | How |
| --- | --- | --- |
| Onboarding with seed papers (PDF, DOI or free-text topic) | Build | OpenAlex resolves DOIs; Nemotron Parse reads PDFs and their bibliographies |
| Question-only onboarding | Build | Cold start: the user picks 3 to 5 seeds from search hits |
| Candidate discovery | Build | The master agent splits the question into about 3 sub-queries and runs a search agent on each: Tavily search over PubMed, PMC, preprint servers and journals; PubMed keyword search and its similar, citing and reference links; OpenAlex papers citing or sharing references with 2+ seeds; Semantic Scholar recommendations; alphaXiv for computational work (see Search sources) |
| Ranking + explanations | Build | Embedding and citation-overlap score, Lightning verdicts, Super VL listwise rerank, quote checked by exact match |
| Early placement | Build | A card goes on the board once its Lightning verdict clears a threshold; the rerank and the summaries update it in place |
| Canvas graph | Build | Seeds and kept papers are squares, suggestions are circles; node size = link count, colour = fit; distance on the canvas = paper similarity (see Clustering and layout); a legend explains the board |
| Clusters | Build | Leiden communities on a similarity graph of embeddings plus citations; Lightning names each cluster |
| "Rank for" goal | Build | A switch in the top bar between the researcher's goals, for example evidence on the disease or a reusable method; colours, ranking and "why" text change with it, as in the organisers' notebook exercise and the mockup |
| Filters and "structure by" | Build | Per-viewer filters dim cards by rating, status, year or source; "Structure by" citation, cluster or year re-runs the layout for unpinned cards |
| Ranked list view | Build | The brief's ranked list, kept in step with the canvas |
| Paper overlay with summary, quotes and figures | Build | A reader agent summarises the paper on its own, then a context agent relates it to the board; Tavily Extract reads PMC and arXiv pages, Parse reads PDFs and crops figures, Super VL picks the key ones |
| PDF highlights as knowledge nodes | Build | pdf.js text layer in the overlay; each highlight becomes a `highlight` shape linked to its paper, categorised by the agent |
| Shared annotations | Build | A note and replies on each highlight, stored on the `highlight` shape, so collaborators see them live through tldraw sync; the overlay renders every member's highlights with their name |
| Quotes and figures on the board | Build | `quote` and `figure` shapes next to their paper; quotes are verbatim or rejected |
| Agent-made tables and diagrams | Build | `add_table` and `add_diagram` canvas tools; diagrams use built-in geo shapes and arrows |
| Catch-me-up tour | Build | The agent reads the activity feed since the member's last visit and steers their view with `_canvas/focus` |
| Chat that points at the board | Build | Clickable paper mentions; `_canvas/highlight` marks the cards behind an answer |
| Keep or discard triage | Build | On the board, in the overlay or during the tour; Keep adds a seed, Discard adds a negative signal |
| Shared board with live cursors | Build | One tldraw sync room per board, already in the Multiplayer starter |
| Invite link, attribution, activity feed | Build | Shows who added, kept or discarded what, the agent included; the feed also drives catch-me-up |
| Chat panel | Build | ACP client in the browser |
| Own MCP server | Build | The same tools our agent uses |
| Daily recommender and project dashboard | Fake | Same pipeline with a "published in the last N days" filter behind a re-run button |
| Login | Fake | Display name plus invite link; real accounts later |
| Cross-field discovery | Stretch | A search strategy that restates the problem in another field's vocabulary (physics, maths, statistics) and searches with it |
| Citation context | Stretch | Where a paper is cited (introduction vs method or results) and whether it argues against a thesis; an LLM classifies citation contexts; verify that Semantic Scholar exposes them |
| Generated visual summaries | Stretch | An image model (Black Forest Labs was suggested) draws a visual summary, labelled as generated and never in place of a real figure |
| @agent in paper comments | Stretch | A comment thread starts a run scoped to that paper |
| Roles and private notes | Cut | Everyone on a board is an editor for the demo |
| LinkedIn and X scraping | Cut | Terms-of-service risk; Tavily covers recent work |
| Paper writing (own editor or Overleaf MCP) | Cut | Over-featured for the hackathon; see Later work |
| "Future work" chaining | Cut | Unreliable on abstracts alone |
| Agent rearranging nodes | Cut | People drag cards; the agent only places new ones |
| Trending-paper cards on the welcome screen | Cut | The team found them ugly and off-topic; new papers live on the board |
| Separate swipe screen for triage | Cut | Triage stays on the board so each paper is seen in context |
| Voice chat and generative UI | Cut | Both floated in the discussion and dropped |

**Answers to the board's open questions:**

- **Separate agents for cold start and daily updates?** No. One pipeline; only the date window and the seed set (board contents plus the discarded list) change.
- **Is the agent reused when a researcher adds a paper they found?** Yes. The added paper becomes a seed and the same pipeline runs around it.
- **Ranking agent or algorithm?** An algorithm for recall and scoring; the LLM only reranks the top results and explains them.
- **Do new papers wait for approval before going on the board?** No. A paper goes on the board as soon as the agent is confident it is relevant, so the researcher sees it in context, and a reader agent starts summarising it straight away. Keep or Discard comes after.
- **Save (Tinder-like) or just delete?** Both, on the board itself rather than on a separate swipe screen. Keep turns a paper into a seed and Discard is a negative signal. On a shared board each researcher's vote shows, and split votes mark the paper "contested".
- **A relevant picture on each card?** Yes: a real figure from the paper chosen by Super VL. A generated visual summary is a stretch and is always labelled as generated.
- **Paper placement agent?** It chooses a cluster or a neighbour; coordinates come from the layout service, because LLMs place things poorly.
- **Rewritten abstracts?** Yes. The reader agent rewrites each abstract in one vocabulary shared across the board, labelled as generated and always shown next to the original abstract and the verified quote.
- **Summarise in isolation or in context?** Both, in two passes: the reader agent first reads the paper on its own (summary, highlights, quotes, figures), then a context agent explains it against the board's question and links it in.
- **Can users edit placement, links and what the agent wrote?** Yes, by hand: placement, links, summaries, notes, tables and diagrams. Anything a person has edited counts as human-touched, so the agent never moves or overwrites it. Quotes stay verbatim; people annotate them instead.

## System architecture

The system has five parts: researcher browsers, a Node board service that owns each shared board, our ADK agent harness, a Python discovery service, and external model and data APIs.

&#91;embedded content: system architecture · shared boards, board service, ADK harness, discovery service\]

Every change to a board, from a person or an agent, lands in the board's sync room, so all researchers see it live and agents can work even when no browser is open.

**Components:**

| Component | Runs as | Responsibility | Tech |
| --- | --- | --- | --- |
| Web app | Static React bundle | Canvas, chat panel, ranked list, paper overlay with PDF viewer and highlights, filters | tldraw SDK, `@tldraw/sync`, ACP TypeScript SDK, pdf.js |
| Board service | Node, one long-lived Nebius Serverless Endpoint | Sync rooms, canvas MCP, ACP pipe, REST API, invites, activity feed | `TLSocketRoom` with SQLite storage, MCP TypeScript SDK, `ws` |
| Agent harness | Python process per researcher session, spawned by the board service | Reasoning loop: master agent, search sub-agents, background reader and context passes | Google ADK, `LiteLlm` to Token Factory, ACP Python SDK |
| Discovery service | Python, second Endpoint | Papers MCP, discovery pipeline, parallel scoring, full text, figures, daily runs | MCP Python SDK, LanceDB, SQLite |
| Model APIs | External | LLMs, embeddings, PDF parsing | Token Factory, NVIDIA hosted API |
| Search and scholarly sources | External | Web search and page reading; metadata, citations, recommendations, keyword search | Tavily, PubMed E-utilities, OpenAlex, Semantic Scholar, alphaXiv |

**Data flow, seeds to shared canvas:**

1. A researcher submits a question and seeds. The browser creates the board over REST, then opens its sync room and an ACP session.
2. The master agent resolves the seeds, splits the question into about 3 sub-queries and runs a search agent on each; they find candidates through the papers MCP.
3. The discovery service scores candidates with Lightning in parallel, verifies quotes and stores the verdicts.
4. As soon as a candidate's verdict clears the threshold, the harness calls `add_papers` and `link_papers` on the canvas MCP, which writes into the board's sync room; every connected browser sees the card appear. When scoring finishes, Super VL reranks the top \~100 and `set_rating` updates the placed cards and the ranked list.
5. For each placed paper a reader agent runs in the background: Tavily Extract or Parse supplies the full text and figures, and the reader writes a summary, highlights, verbatim quotes and key figures to the board. A context agent then explains why the paper matters for this board and links it in. The card shows a "working" badge until both finish.
6. Opening a paper fetches its full record over REST and shows the overlay with the PDF and its highlights.
7. A researcher's highlight and its annotation are saved as a `highlight` shape in the room, so every collaborator sees them live, in the PDF and on the board, and the agent reads them through `get_board`.
8. Keep or Discard goes over REST, is recorded per researcher, and updates the card's status in the room.

**Clustering and layout:**

Closeness on the canvas means similarity: two cards near each other are about related things. Clusters come from data, not from the agent's judgement, so they are reproducible and explainable.

- **Similarity between two papers** blends meaning and citations: `similarity = 0.6 × cosine(embeddings) + 0.4 × citation overlap`. Embeddings are of title plus abstract (or the rewritten abstract once the reader has run). Citation overlap is the mean of bibliographic coupling (Jaccard overlap of their reference lists) and co-citation (how often other candidates cite both). Distance is `1 − similarity`. Embeddings catch papers on the same topic that never cite each other, including across fields; citations catch papers that are close within a field. The weights are a starting point, tuned on the held-out evaluation.
- **Clusters.** The discovery service builds a k-nearest-neighbour graph (k ≈ 10, edges weighted by similarity) over the board's papers and finds communities with Leiden. That takes milliseconds for a few hundred papers and needs no GPU. Lightning then names each cluster from its papers' titles; the label is shown as generated and people can rename it.
- **Layout.** A force-directed layout (d3-force) in the board service: links pull with a strength equal to similarity, each cluster pulls its cards towards its own centre, and cards repel so they never overlap. Cluster centres are placed by their average similarity to each other, so related clusters sit side by side.
- **Stability.** Clustering runs once after the first discovery run and again only when someone presses "Structure by cluster". In between, a new paper joins the cluster of its most similar neighbour and is placed beside it without moving anything else.
- **What the agent does.** It never invents clusters or coordinates. It names clusters (`label_cluster`) and, through `near`, can suggest a neighbour; the layout service checks the suggestion against similarity.

**Canvas layout rules:**

- A layout service inside the board service places new cards next to their most similar neighbour, inside that neighbour's cluster, avoiding overlaps.
- Seeds and kept papers are squares; suggestions are circles. Node size = number of links; colour = fit to the current goal (low, medium, high); badges mark new, working, kept and contested papers. Discarded papers are hidden behind a "Show" link in the legend.
- Highlights, quotes, figures and agent notes sit next to their paper card, linked to it.
- Agents name a cluster or a neighbour (`near`), never coordinates.
- A card a person has moved is pinned; the agent never moves it again. "Structure by" is a person's action and re-runs the layout for unpinned cards only.

**Design choices:**

- **The sync room is the single source of truth for the canvas.** The canvas MCP writes into it on the server through the room's storage transaction (`updateStore` in older tldraw versions). There is no browser relay, and no dependence on anyone's tab being open.
- **Shared changes through MCP, per-viewer actions through ACP.** Adding papers changes the board for everyone. Focusing a card, opening the overlay or highlighting the cards behind an answer goes only to the requesting researcher's client, as an ACP extension notification.
- **One owner of agent logic.** We skip the tldraw agent starter kit's in-browser agent loop.
- **Two Endpoints.** The board service holds stateful WebSockets and agent processes; the discovery service holds stateless tools and scheduled runs. Models stay on Token Factory, separate from the app, as the brief requires.

## Collaboration on the board

A board is a shared workspace: everyone invited sees the same canvas live, every change is attributed, and the agent acts as one more participant that follows the team's decisions. Most of this comes with tldraw sync, and it is a supporting feature, not the pitch (see Overview). It helps teams that split one project, for example one person on methodology and another on datasets, and researchers wary of AI, who can see who added what.

**Concepts:**

| Concept | What it is | Where it lives |
| --- | --- | --- |
| Board | One research project: question, seeds, canvas | `boards` table + one sync room |
| Member | A researcher on the board, with role owner, editor or viewer (everyone is an editor in the demo) | `members` |
| Invite | A link carrying a role and an expiry | `invites` |
| Paper card | A paper on the canvas with its status (new, kept, contested) and who added it | Sync room shape + `board_papers` |
| Vote | One researcher's Keep or Discard on one paper | `decisions` |
| Note | A sticky or comment with its author | Sync room shape, author in shape meta |
| Highlight | A categorised passage of a paper with an optional annotation and replies, linked to its card; a knowledge node agents work from | Sync room shape, author in shape meta |
| Run | One agent job: who asked, scope, status, cost | `runs` |
| Event | One line of the activity feed | `events` |

**What researchers see together:**

- Live cursors and names, plus cards, links and notes as they change ([tldraw sync](https://tldraw.dev/sdk-features/collaboration)).
- Each other's highlights and annotations inside a paper: open a paper a colleague is reading and their highlights, notes and replies are already there, labelled with their name, and new ones appear as they are made.
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
- **Human-touched cards are locked.** A card a person moved, edited or pinned is never moved by the agent, and a summary, note, table or diagram a person edited is never overwritten.
- **The agent proposes, people decide.** It never deletes a person's card or note, and never votes.
- **Every agent write is traceable.** It carries `meta.createdBy = "agent"`, `meta.onBehalfOf` (the member ID) and `meta.runId`, so a whole run can be reviewed or undone.

**Access for the demo:**

- A display name plus an invite link with a signed token. Roles are stored but not enforced.
- Each researcher gets one board-scoped token. The browser passes it to the agent's MCP connections, so agent writes are attributed to the right person.
- Later: real accounts (ORCID or Google sign-in), enforced roles, private notes and notification settings.

## Agent design

The harness is built on Google ADK and owns only the reasoning loop; search, scoring, reading, figures and board edits live behind MCP, so another agent could replace it without losing features.

**ADK agents and their models:**

| Agent | Model | Job | Main tools |
| --- | --- | --- | --- |
| `master` | Nemotron 3.5 Super VL | Plans the run, splits the question into sub-queries, talks to the researcher, places results, gives the catch-me-up tour | Canvas MCP, papers MCP, `search` (as a tool), `process_papers` |
| `search` | Nemotron 3.5 Lightning | Runs one sub-query: keyword search, expansion from the seeds, recommendations, recent work | `search`, `find_candidates` |
| `reader` | Nemotron 3.5 Super VL | Reads one paper on its own: summary, rewritten abstract, highlights, verbatim quotes, key figures | `get_fulltext`, `get_figures`, `pick_figure`; canvas `set_summary`, `add_highlight`, `add_quote`, `add_figure` |
| `context` | Nemotron 3.5 Lightning | Relates one paper to the board: why it matters for the question, which seeds, notes and highlights it connects to | `get_board`, `set_summary`, `link_papers` |
| Bulk scoring (a tool, not an agent) | Nemotron 3.5 Lightning | Verdict, TL;DR and verified quote for hundreds of candidates | `score_candidates`, run in parallel inside the discovery service |

Bulk scoring is a tool because an LLM looping over 300 papers is slow and costly. `score_candidates` sends one Lightning request per paper in parallel, stores every verdict and returns only the top results to `master`.

The reader and context passes are deliberately separate. The reader looks at the paper in isolation, so its summary and highlights stay faithful to the paper; the context agent then works from those outputs and the board, not from the whole paper again.

```python
import asyncio
import os
from google.adk.agents import LlmAgent
from google.adk.models.lite_llm import LiteLlm
from google.adk.tools.agent_tool import AgentTool
from google.adk.tools.mcp_tool import McpToolset
from google.adk.tools.mcp_tool.mcp_session_manager import StreamableHTTPConnectionParams

from harness.background import read_then_relate

TF = dict(api_base="https://api.tokenfactory.nebius.com/v1/", api_key=os.environ["TF_API_KEY"])
super_vl = LiteLlm(model="openai/nvidia/Nemotron-3.5-Super-VL", **TF)
lightning = LiteLlm(model="openai/nvidia/Nemotron-3_5-Lightning", **TF)


def build_agent(canvas_url: str, papers_url: str, token: str) -> LlmAgent:
    auth = {"Authorization": f"Bearer {token}"}
    canvas = McpToolset(connection_params=StreamableHTTPConnectionParams(url=canvas_url, headers=auth))
    papers = McpToolset(connection_params=StreamableHTTPConnectionParams(url=papers_url, headers=auth))
    search = LlmAgent(name="search", model=lightning, tools=[papers],
                      instruction="Run one sub-query: search by keyword, expand from the seeds, return candidate IDs.")
    reader = LlmAgent(name="reader", model=super_vl, tools=[papers, canvas],
                      instruction="Read one paper on its own. Write its summary, highlights, verbatim quotes and key figures to the board.")
    context = LlmAgent(name="context", model=lightning, tools=[canvas],
                       instruction="Explain why one paper matters for the board's question and link it to what it connects to.")
    pending: set[asyncio.Task] = set()

    async def process_papers(paper_ids: list[str]) -> dict:
        """Start the reader pass, then the context pass, for each placed paper in the background."""
        for paper_id in paper_ids:
            task = asyncio.create_task(read_then_relate(reader, context, paper_id))
            pending.add(task)
            task.add_done_callback(pending.discard)
        return {"started": len(paper_ids)}

    return LlmAgent(name="master", model=super_vl, tools=[canvas, papers, AgentTool(agent=search), process_papers],
                    instruction="Split the question into about 3 sub-queries and search each one, score the candidates, "
                                "place confident papers on the canvas straight away, then process them.")
```

`build_agent` runs once per ACP session: the canvas URL and the researcher's board token come from that session's `mcpServers`, so every write is attributed to the right person. The `openai/` prefix tells LiteLLM to treat Token Factory as an OpenAI-compatible endpoint. Sub-agents are just tools: `search` is wrapped in `AgentTool`, so the master calls it once per sub-query, and when the model emits several calls in one turn ADK can run them concurrently (confirm this on the pinned ADK version). `process_papers` starts each paper's reader and context passes as background tasks with their own runners (`read_then_relate`), so the master keeps working while the cards fill in.

**Discovery and ranking pipeline:**

1. **Resolve seeds** (`resolve_seed`). A DOI becomes an OpenAlex record; a PDF goes through Nemotron Parse for title, DOI and bibliography.
2. **Split the question.** The master writes about 3 sub-queries (for example by method, population and outcome) and runs `search` on each.
3. **Generate candidates** (`search`, `find_candidates`). Per sub-query: Tavily search over PubMed, PMC, preprint servers and journals, and PubMed keyword search. Around the seeds: PubMed's similar-article, citing and reference links, OpenAlex papers that cite 2+ seeds or share references with them, and Semantic Scholar recommendations. alphaXiv adds computational work from arXiv. Keyword and web hits only match words, so every candidate is re-scored by embeddings in the scoring step.
4. **Deduplicate.** Drop seeds and the board's discarded papers, first by DOI, then by normalised title.
5. **Score** (`score_candidates`). Embedding similarity to the question and seeds, citation overlap and recency, then a Lightning JSON verdict per candidate.
6. **Verify.** The quote must appear verbatim in the abstract; otherwise the explanation is flagged "unverified". Its source link gets a `#:~:text=` fragment so a click highlights the quote.
7. **Place early** (`add_papers`, `link_papers`, `mark_working`). Each candidate whose verdict clears the threshold goes onto the canvas straight away with a "working" badge, and the layout service positions it.
8. **Rerank** (`rerank`). Once scoring finishes, Super VL ranks the top \~100 listwise with all seed abstracts in context; `set_rating` updates the placed cards and the ranked list.
9. **Read** (`process_papers` → `reader`). For each placed paper, Tavily Extract reads its PMC or arXiv page, and Parse reads the open-access PDF when there is no such page and crops the figures. The reader writes a summary, a rewritten abstract, highlights, quotes checked verbatim against the full text, and the key figures. Papers without an open-access PDF get an abstract-only summary, marked as such.
10. **Relate** (`context`). The context agent explains why the paper matters for this board and links it to the seeds, notes and highlights it connects to; then the badge clears.
11. **Cluster** (`cluster_papers`, `label_cluster`). After the first run, the discovery service clusters the board's papers by similarity and the layout service arranges them; Lightning names each cluster. Later runs add papers to existing clusters until someone re-structures the board.

**Memory.** Per board: seeds, kept and discarded papers, verdicts, full text and embeddings, in the discovery service (LanceDB and SQLite); notes, highlights and summaries live in the sync room. Per researcher: their chat history, in the ADK session, and the last activity they saw, for catch-me-up. Discarded papers are a negative signal for every later run, whoever discarded them.

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
- **Custom shapes** (`paper-card`, `cluster`, `highlight`, `quote`, `figure`, `table`) are registered in both the server schema and the client.

### ACP: one researcher's conversation

1. **`initialize`.** The client declares no `fs` or `terminal` capabilities. The agent declares HTTP MCP support plus image and embedded-context prompts.
2. **`session/new`.** The client sends `cwd` and `mcpServers`: the board's canvas MCP and the papers MCP, each with the researcher's board token as an `Authorization` header.
3. **`session/prompt`.** User text, the selected paper cards and highlights as embedded `resource` blocks, and a viewport screenshot as an `image` block.
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
| Per-viewer action | Extension notification `_canvas/focus`, `_canvas/open_paper` or `_canvas/highlight` | That researcher's view moves or the cards behind an answer light up; nobody else's view changes |

A catch-me-up tour is an ordinary prompt: the master reads the activity feed since the researcher's last visit, then streams message chunks interleaved with `_canvas/focus` notifications that zoom in on each new paper and back out. Paper mentions in chat messages carry the paper ID, so clicking one sends the same focus locally.

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
- **Shared changes only through the canvas MCP.** Per-viewer actions (focus, open the overlay, highlight cards) go through ACP extension notifications instead.
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
| GET | `/boards` | Boards the caller belongs to, with counts of new papers | → `[Board]` |
| GET | `/boards/{id}` | Board details, members and seeds | → `Board` |
| POST | `/boards/{id}/invites` | Create an invite link | `{role, expiresInHours}` → `{url}` |
| POST | `/invites/{token}/accept` | Join a board | `{displayName}` → `{member, boardToken}` |
| POST | `/boards/{id}/seeds` | Add a seed by DOI or PDF upload | `{doi}` or multipart PDF → `Paper` |
| POST | `/boards/{id}/runs` | Start a run without chat (onboarding, daily, around one paper) | `{kind, paperId?}` → `Run` |
| GET | `/boards/{id}/runs/{runId}` | Run status and counts | → `Run` |
| DELETE | `/boards/{id}/runs/{runId}` | Cancel a run | → 204 |
| GET | `/boards/{id}/inbox` | New papers waiting for the caller's vote, for badges and the tour | `?status=pending` → `[PaperCard]` |
| GET | `/boards/{id}/papers` | The ranked list beside the canvas | `?sort=rank&status=new` → `[PaperCard]` |
| PUT | `/boards/{id}/papers/{paperId}/vote` | Keep or Discard | `{decision}` → `{status, votes}` |
| GET | `/boards/{id}/papers/{paperId}` | Full record for the paper overlay | → `Paper` |
| GET | `/boards/{id}/papers/{paperId}/pdf` | The PDF for the overlay: the uploaded seed, or the open-access copy proxied to avoid CORS | → PDF |
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
| `get_board` | none | `{question, seeds, papers, clusters, notes, highlights, discardedIds}` | A compact summary, never raw shapes; includes people's sticky notes and highlights |
| `add_papers` | `{papers: [{paperId, near, rating, reason}], runId}` | `{added, skipped}` | Append-only; the layout service places cards |
| `link_papers` | `{from, to, relation}` | `{linkId}` | Relation: cites, cited\_by, similar, contradicts or extends |
| `set_rating` | `{paperId, score, verdict}` | `{ok}` | Score 0 to 1; sets the card colour |
| `add_note` | `{text, paperId}` | `{noteId}` | Authored as the agent on behalf of the member |
| `apply_clusters` | `{clusters: [{clusterId, paperIds}], similarities}` | `{ok}` | Writes cluster frames and re-runs the layout for unpinned cards; takes the board lease |
| `label_cluster` | `{clusterId, label}` | `{ok}` | Shown as generated; skipped if a person has renamed the cluster |
| `mark_working` | `{paperIds, on}` | `{ok}` | The "working" badge everyone sees |
| `set_summary` | `{paperId, summary, tldr, rewrittenAbstract, whyItMatters}` | `{ok, skipped}` | Skips fields a person has edited |
| `add_highlight` | `{paperId, text, page, category, note}` | `{highlightId}` | Anchored by finding `text` in the PDF text layer; the category sets the colour |
| `add_quote` | `{paperId, text, section}` | `{quoteId}` | Rejected unless `text` appears verbatim in the abstract or full text |
| `add_figure` | `{paperId, figureId, why}` | `{shapeId}` | Places the cropped figure next to its card |
| `add_table` | `{title, columns, rows, near}` | `{shapeId}` | For example methods or datasets across papers |
| `add_diagram` | `{title, nodes, edges, near}` | `{shapeIds}` | Built-in geo shapes and arrows; the layout service places them |

There is no selection tool, no vote tool and no layout tool: selection is per viewer and arrives in the prompt, only people keep or discard, and only people restructure the board.

### Papers MCP tools (discovery service, `/mcp`)

| Tool | Input | Output |
| --- | --- | --- |
| `resolve_seed` | `{doi, pdfUrl, title}` (any one) | `Paper` |
| `find_candidates` | `{boardId, seedIds, excludeIds, strategies, since, limit}` | `{candidateIds, countsByStrategy}` |
| `score_candidates` | `{boardId, candidateIds, goals}` | `{top, scored, unverified}` |
| `rerank` | `{boardId, paperIds, k, goal}` | `{ranked, backend}` |
| `cluster_papers` | `{boardId, paperIds}` | `{clusters: [{clusterId, paperIds}], similarities: [{a, b, score}]}`, the k nearest neighbours per paper |
| `search` | `{query, limit}` | `[PaperSummary]` |
| `get_paper` | `{paperId}` | `Paper` |
| `get_fulltext` | `{paperId}` | `{sections: [{title, text, page}], source}`, with `source` either the PDF or the abstract only |
| `get_figures` | `{paperId}` | `[{figureId, caption, imageUrl, page, bbox}]` |
| `pick_figure` | `{boardId, paperId}` | `{figureId, why}` |

`score_candidates` scores every candidate once per board goal (for example evidence and method), so switching "Rank for" only re-sorts and recolours; `rerank` runs for the goal being viewed. `strategies` is any of keyword (PubMed and OpenAlex), pubmed_links (similar, citing and references), citing, coupling, recommend (Semantic Scholar), web (Tavily) and arxiv (alphaXiv), plus crossfield as a stretch. The harness passes `excludeIds` from `get_board`, so the discovery service never needs the board's votes directly.

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
  "type": "article",
  "relevance": {
    "goal": "evidence",
    "score": 0.82,
    "fit": "high",
    "verdict": "relevant",
    "relation": "Same disease · adds a spatial method",
    "claims": [{ "text": "Profiles the same exhausted CD8+ T-cell states as three of your seeds…", "evidence": ["q1", "c1"] }],
    "quotes": [{ "id": "q1", "text": "…", "source": "abstract", "verified": true, "url": "https://pubmed.ncbi.nlm.nih.gov/…/#:~:text=…" }],
    "citations": [{ "id": "c1", "citesSeeds": ["…"], "source": "openalex" }],
    "gaps": ["Whether it supports or challenges your seeds' findings: not assessed"],
    "figure": { "figureId": "fig3", "caption": "…", "imageUrl": "…", "why": "…", "model": "…", "seconds": 3.1 },
    "model": "nvidia/Nemotron-3_5-Lightning",
    "seconds": 0.8,
    "runId": "run_…"
  },
  "reading": {
    "tldr": "…",
    "summary": "…",
    "rewrittenAbstract": "…",
    "whyItMatters": "…",
    "fullText": true,
    "sections": { "summary": "done", "quotes": "done", "figure": "reading" },
    "highlightIds": ["…"]
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

The fields follow what the card mockup needs (`docs/mockups/README.md`): every claim in "why it matters" points to evidence IDs, and a claim with no evidence is dropped or flagged; several quotes, each verified on its own; `gaps` for "Couldn't check"; the `relation` tag and the `goal` the ranking used; `type` (article, review or preprint) from OpenAlex; per-section progress so each section fills in on its own; and the model and time for every AI-written label.

### Canvas shapes

| Shape | Props | Meta |
| --- | --- | --- |
| `paper-card` (custom) | `paperId`, `title`, `year`, `rating`, `status`, `w`, `h` | `createdBy`, `onBehalfOf`, `runId`, `pinnedByHuman` |
| Arrow (built-in, bound to two cards) | Start and end bindings | `relation`, `createdBy` |
| Note (built-in) | Rich text | `author` |
| `cluster` (frame) | `label`, `labelGenerated` | `createdBy`, `renamedByHuman` |
| `highlight` (custom) | `paperId`, `text`, `page`, `category`, `note`, `replies` (`[{author, text, at}]`) | `author` or `createdBy`, `runId` |
| `quote` (custom) | `paperId`, `text`, `section`, `verified` | `createdBy`, `runId` |
| `figure` (custom) | `paperId`, `figureId`, `imageUrl`, `caption` | `createdBy`, `runId` |
| `table` (custom) | `title`, `columns`, `rows` | `createdBy`, `runId`, `editedByHuman` |
| Geo shapes (built-in, for diagrams) | Label and kind | `createdBy`, `runId`, `editedByHuman` |

### Storage

| Table | Key columns | Owner |
| --- | --- | --- |
| `boards` | `id`, `title`, `question`, `context`, `created_by` | Board service |
| `members` | `board_id`, `member_id`, `display_name`, `role`, `last_seen_seq` | Board service |
| `invites` | `token`, `board_id`, `role`, `expires_at` | Board service |
| `board_papers` | `board_id`, `paper_id`, `status`, `rating`, `cluster`, `added_by`, `run_id` | Board service |
| `decisions` | `board_id`, `paper_id`, `member_id`, `decision`, `at` | Board service |
| `runs` | `id`, `board_id`, `requested_by`, `kind`, `status`, `started_at`, `tokens_used` | Board service |
| `events` | `seq`, `board_id`, `actor`, `type`, `payload` | Board service |
| `papers` | `paper_id`, `doi`, `pmid`, `title`, `authors`, `year`, `abstract` | Discovery service |
| `verdicts` | `board_id`, `paper_id`, `score`, `verdict`, `reason`, `quote`, `quote_verified`, `model`, `run_id` | Discovery service |
| `fulltext` | `paper_id`, `section`, `page`, `text` | Discovery service |
| `figures` | `paper_id`, `figure_id`, `caption`, `image_path`, `page`, `bbox` | Discovery service |
| `paper_vectors` (LanceDB) | `paper_id`, `vector`, `text` | Discovery service |

The board service owns everything about the board and its people; the discovery service owns everything about papers. Each runs on its own SQLite, so the two Endpoints share no database.

## NVIDIA model routing

Each job goes to the Nemotron model built for it, and the routing is visible in the demo; this is how we compete for Best use of Nemotron. Hard planning goes to a large reasoning model, repetitive execution to Lightning, as NVIDIA itself positions them.

| Job | Model | Runs on |
| --- | --- | --- |
| Master agent: planning, splitting the question, chat, final listwise ranking, catch-me-up | Nemotron 3.5 Super VL (`nvidia/Nemotron-3.5-Super-VL`) | Token Factory |
| Reader agent: full text, figures and pages, highlights and quotes, picking figures; reading the canvas screenshot | Nemotron 3.5 Super VL | Token Factory |
| Per-paper work on hundreds of candidates (verdict, TL;DR, quote, citation stance), search agents, context agent | Nemotron 3.5 Lightning (`nvidia/Nemotron-3_5-Lightning`) | Token Factory |
| PDF parsing for seeds and placed papers, bibliography extraction, figure cropping | Nemotron Parse | NVIDIA hosted API |
| Optional rerank by text plus first-page image | Llama Nemotron Rerank VL 1B v2, or a Nemotron reranker if Token Factory serves one | Token Factory if available, else NVIDIA hosted API |
| Embeddings | A Nemotron embedding if Token Factory lists one, else Qwen3-Embedding-8B | Token Factory |

**Embeddings and reranking are pluggable.** We host no embedding or rerank containers ourselves. The embedder is any OpenAI-compatible `/v1/embeddings` endpoint, chosen by configuration (`EMBED_BASE_URL`, `EMBED_MODEL`), with Token Factory as the default; changing the model means re-embedding the board's papers in LanceDB, which is cheap at a few hundred papers. The `rerank` tool has interchangeable backends, chosen by `RERANK_BACKEND`: Super VL listwise (the default), a rerank model on Token Factory, or NVIDIA's hosted Rerank VL. Token Factory's API docs list an embeddings endpoint but no rerank endpoint, so a Token Factory reranker would need a dedicated endpoint with custom weights; check that before relying on it.

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

**More models.** The team wants as many Nemotron models as do a real job, since that is what impresses for Best use of Nemotron. If time allows, add the Rerank VL step above and look for one more real job, such as Content Safety on agent-written notes. Not planned: self-hosting embedding or rerank containers on our own GPUs (the pluggable endpoints above cover them) and Nano Omni voice input (voice was floated and dropped).

## Search sources

Tavily finds and reads papers on the web; the scholarly APIs give identities and the citation graph. The organisers' notebook draws the same line: Tavily for web context and paper pages, scholarly sources for citation links. Every source is a tool call in the trace.

| Source | Job | Checked on 18 October |
| --- | --- | --- |
| **Tavily Search** | The search agents' main tool: each sub-query restricted to PubMed, PMC, bioRxiv, medRxiv, arXiv and journals; recent work by date window; web context such as trials and guidelines | Restricted to PMC, a query from the notebook's melanoma example returned 5 on-topic papers, 2 of them seeds |
| **Tavily Extract** | Reading: the full text the reader quotes from | PMC returned full text (no images); arXiv HTML returned text and figure images; bioRxiv failed, so bioRxiv papers go through their PDF |
| **PubMed E-utilities** | Structured keyword search (ESearch), abstracts (EFetch), and per-paper links (ELink): similar articles, citing papers and references | For the 2021 CD8 seed (PMID 34290406): 100 similar, 374 citing, 37 references; no key needed |
| **OpenAlex** | DOIs, open-access PDF links, citing papers across disciplines | Not checked |
| **Semantic Scholar** | Recommendations that take positive and negative paper IDs, so Keep and Discard steer them | Not checked; needs a key for steady use |
| **alphaXiv** | arXiv papers and their AI-generated summaries: computational and modelling work for the cross-field angle | The melanoma example returned modelling and q-bio papers, none of the experimental literature, so it adds an angle rather than replacing PubMed |

**Rules:**

- **A web hit isn't a paper yet.** Tavily URLs are resolved to a PMID, DOI or arXiv ID before scoring, and seeds are dropped; the PMC search above returned two seeds.
- **Tavily runs through its remote MCP server** (`https://mcp.tavily.com/mcp/`, the integration Tavily documents for Google ADK) or the Python SDK inside the papers MCP, with the server's own key.
- **Credits.** Search costs 1 credit (basic) or 2 (advanced); Extract costs 1 credit per 5 pages. A run with 3 advanced sub-queries and 50 extracted papers costs about 16 credits. Log usage per run with `include_usage=True`.
- **PubMed limits.** 3 requests a second without an NCBI key, 10 with one.
- **Is there an organisers' PubMed MCP?** The brainstorm mentioned one, but the notebook calls E-utilities directly. If there is none, ESearch, EFetch and ELink become tools in our papers MCP.
- **Not used:** Tavily Research (4 to 250 credits and minutes per call), Crawl and Map.

## Requirements, risks and first-hour checklist

The biggest risks are plumbing nobody sees (WebSockets on Nebius, LiteLLM tool calling, the ACP pipe), PDF handling, a Build list that grew, and people and agents editing one board at once; each has a cheap first-hour check or a rule.

**Hard requirements (both challenges):**

- LLM inference and embeddings on Nebius Token Factory (Nemotron models; Beam optional).
- Web retrieval through Tavily.
- A working app deployed on Nebius (Nebius Serverless, per the organisers' notebook), hosted separately from the model endpoint.
- Output: a ranked list of new papers with metadata, source links and relevance explanations.
- A public GitHub repo with a README a judge can run from.
- A 2-minute demo video of one complete run, submitted on the hackathon platform by 18:30.

| Risk | What breaks | Mitigation |
| --- | --- | --- |
| tldraw licence in production | Since SDK 4.0 the canvas needs a licence key outside development | Get the free 100-day trial key in the first hour; multiplayer sync is included in the SDK licence |
| WebSockets on Nebius Serverless | No sync and no ACP stream | Deploy a hello-world Endpoint with a WebSocket first; fallback to SSE plus POST for ACP |
| Nemotron tool calling through LiteLLM | Agents can't call tools | Test both models with one MCP tool in the first hour; pin ADK and LiteLLM versions once it works |
| People and agents editing at once | Cards jump or get overwritten | Agent appends only; human-touched cards locked; per-board lease for layout changes |
| Sync room persistence | A restart loses the board | SQLite storage on a mounted volume; snapshot each board when a run finishes |
| One harness per collaborator | Memory and token spend grow with the team | Close idle sessions after 10 minutes; queue headless runs |
| ACP plumbing effort | About half a day for one person | Keep the pipe dumb and reuse the SDKs; fallback is ADK's own API server with SSE |
| Parse latency | Cards stay "working" for long | Run on seeds and placed papers only, in the background; cache full text and figures |
| PDF access | Many candidates have no open-access PDF | Abstract-only summaries, marked as such; researchers can upload a PDF |
| PDF highlighting in the overlay | Text selection fights canvas events; agent highlights land in the wrong place | Render pdf.js in the overlay outside tldraw's event handling; anchor agent highlights by searching the quote in the text layer; fallback is highlighting Parse's extracted text instead of the PDF |
| Scope | The Build list no longer fits the time | Build in demo order: board filling live, overlay with quotes, catch-me-up, then highlights, then tables, diagrams and filters |
| NVIDIA hosted API for Parse and rerank | Requirement dispute | Confirm with the organisers in one message |
| Run too slow for the video | The 2-minute video can't show one uncut run | Place cards as soon as verdicts clear the threshold; Tavily Extract before Parse; time a full run on the demo seeds early |
| Tavily credits | The free tier runs out mid-build | About 16 credits a run; ask the organisers for more, as the challenge offers; log usage per run |
| Hallucinated explanations | A judge's click fails and trust is gone | Exact-match quote check against the abstract or full text; "unverified" flag; `add_quote` rejects anything not verbatim |

**First-hour checklist:**

- [ ] Get the tldraw trial licence key
- [ ] Deploy a hello-world Endpoint on Nebius Serverless with a WebSocket and confirm it stays connected
- [ ] Run tool calling through ADK `LiteLlm` with Super VL and Lightning on Token Factory
- [ ] Stand up one `TLSocketRoom` with two browsers and one server-side write
- [ ] Confirm with the organisers that Parse and rerank via NVIDIA's hosted API are allowed
- [ ] Check the Token Factory catalogue for a Nemotron embedding model, and whether a rerank model can run there (a dedicated endpoint with custom weights)
- [ ] Run our seed papers through OpenAlex and check the candidate count
- [ ] Ask the organisers whether a PubMed MCP exists; otherwise wrap ESearch, EFetch and ELink as papers MCP tools
- [ ] Connect Tavily's remote MCP server to the ADK harness and run one sub-query through it
- [ ] Confirm alphaXiv access from our server (API or MCP) and its limits
- [ ] Make the GitHub repo public and keep its README runnable from a clean checkout
- [ ] Check how many of our candidates have an open-access PDF
- [ ] Render a PDF with pdf.js in an overlay above tldraw and save one text highlight as a shape

## Open questions and later work

**Open questions:**

- [ ] How many hours do we have? Ralph owns the UI and user flows and the others split the backend and agents; the hours set how much of the Build list survives.
- [ ] What exactly does Best use of Nemotron judge? The award exists; its criteria aren't in our notes.
- [ ] Similarity weights: is 0.6 embeddings / 0.4 citations right? Check against the held-out evaluation, and see whether citations are too sparse for very recent preprints.
- [ ] Which highlight categories? Method, dataset and result came up; the agent assigns them, but can a researcher override?
- [ ] Are pluggable agents part of the pitch? If not, ADK's own API server with SSE replaces the ACP layer and saves 2 to 3 hours.
- [ ] Does a Nebius Serverless Endpoint allow one harness process per session, and how much memory does each need?
- [ ] Triage policy: does one Keep put a paper on the canvas, or do we want a majority of the board?

**Later work:**

- **Paper editor inside tldraw.** A basic document shape takes days, a usable one weeks, and a collaborative editor with citations months. Two routes: TipTap rich text that exports to LaTeX, or a LaTeX-native CodeMirror shape with a compiled PDF preview (Tectonic or texlive in WASM). The hard parts are canvas event conflicts, text under zoom, long documents, paper semantics, and collaborative text editing, which needs Yjs alongside tldraw sync because tldraw merges per record.
- **Collaboration beyond the demo:** real accounts (ORCID or Google sign-in), enforced roles, private notes, @agent in comment threads, and notifications for new papers.
- **MCP-over-ACP** once it stabilises, so the client can host tools over the ACP channel.
- **Scholar-profile onboarding** and personal recommendation settings.
- **More sources,** such as Hugging Face papers and social media, once terms of service are checked, and channels each researcher picks for the daily run.
- **Floated, not planned:** animated explainers with 3Blue1Brown's Manim, and the agent writing a review paper from the board.

## Sources

- [Research Paper Discovery notebook and brief](https://gzvqcrohgpzewcnfecrk.supabase.co/storage/v1/object/public/techeurope-assets/track-media/04cf15c6a046.ipynb) (copy in `docs/research-paper-discovery.ipynb`)
- [Nebius cookbook: deep research agent with Tavily](https://dev.nebius.com/cookbook/deep-research-agent-tavily)
- [Nebius cookbook: Beam on Token Factory with Mirror and Tavily](https://dev.nebius.com/cookbook/beam-reflection-token-factory)
- [Tavily with Google ADK (remote MCP server)](https://docs.tavily.com/documentation/integrations/google-adk)
- [Tavily credits and pricing](https://docs.tavily.com/documentation/api-credits)
- [PubMed E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25501/)
- [Semantic Scholar recommendations API](https://api.semanticscholar.org/api-docs/recommendations)
- [alphaXiv](https://www.alphaxiv.org)
- [Team Miro board](https://miro.com/app/board/uXjVEY7-bbE=/)
- [Granola transcript of the team brainstorm, 18 October](https://notes.granola.ai/d/a4b2a746-9f42-444f-b290-da7e3a942dcd)
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
