# T05: Chat panel: browser ACP client

| Field | Value |
| --- | --- |
| Lane | Browser |
| Size | M |
| Depends on | T03 (and T04 echo mode to test against) |
| Unblocks | T06, T07, T12; since Oct 20 also [T16](T16-start-and-home-pages.md), the T10 and T13 refreshes (all through `chatBus`) |
| Milestone | M1 (built); the Oct 20 refresh is W1 Nothing broken |
| Priority | P1 (refresh) |
| Status | Built on branch `w1/chat-start` (Oct 20): the refresh (chat bus, resources on send, Find more through the bus, no blank bubbles), on top of the panel merged in [PR #13](https://github.com/kmariuszk/nebius-hackathon/pull/13) (Oct 18). Left: refresh criterion 1 checked by hand in a browser; `chat/fixtures/masterTurn.json` is modelled on what `mapping.py` and `trace.py` send, to swap for a live capture |
| Owner | TBD |

## Where it stands (Oct 20)

| Part | State | Where |
| --- | --- | --- |
| Panel beside the canvas, rail when closed, opened from the top bar | Built | `client/client/chat/ChatPanel.tsx`, `chat.css` |
| ACP over the WebSocket, one harness per chat, Stop, Reconnect | Built | `chat/connection.ts`, `client/server/acpPipe.ts` |
| Thoughts, plan, tool cards (model, time, cost), permission prompt | Built | `chat/chatState.ts`, `ThoughtBlock.tsx`, `PlanList.tsx`, `ToolCard.tsx`, `PermissionPrompt.tsx` |
| Paper links (`paper:` URLs) focus the board | Built | `chat/AgentMessage.tsx`, `chat/viewerActions.ts` |
| Sending a prompt from elsewhere in the app | Missing: "Find more like this" dispatches `pdc:ask` and nobody listens (F18); the Start page has no way to send the first prompt (F11) | `client/client/widgets/parts.tsx` |
| Whitespace between tool cards | Each whitespace-only message chunk after a tool card starts a new message item, so blank bubbles appear (F5) | `chat/chatState.ts`, `applyUpdate` (`if (!text) return state` lets `"\n"` through) |
| "Follow the agent", "Include my view" | Not built; they belong to [T06](T06-viewer-actions.md) and [T07](T07-board-context.md) | — |

## What's left (v6)

**A chat bus** (`client/client/chat/chatBus.ts`), the one way the rest of the app talks to the agent:

```ts
export interface AskRequest {
	text: string
	/** Extra ACP `resource` blocks after the text, e.g. T13's tldraw://<boardId>/changes. */
	resources?: { uri: string; mimeType: string; text: string }[]
}
export const chatBus = {
	ask(request: AskRequest): void,           // queued until a ChatPanel takes it
	onAsk(handler: (r: AskRequest) => void): () => void,
}
```

- `ChatPanel` subscribes with `onAsk`: it opens itself (`onOpenChange(true)`), connects if it hasn't, and sends the request once its status is `ready` and no turn is running (a running turn queues it). One request is sent once, even if the panel re-renders.
- `send` takes the resources and appends them as `{type: "resource", resource: {uri, mimeType, text}}` blocks after the text block; `harness/acp/mapping.py` already turns `tldraw://…/changes` into `<board-changes>`.
- `parts.tsx`' "Find more like this" calls `chatBus.ask({text})` instead of dispatching `pdc:ask` (the event and its fallback toast go).
- Users: [T16](T16-start-and-home-pages.md) (the onboarding prompt), the [T10 refresh](T10-paper-card.md) (Find more), the [T13 refresh](T13-board-chrome.md) (Update suggestions).

**No blank bubbles:** in `applyUpdate`, a whitespace-only chunk is appended to the current message item if there is one, and dropped if it would start a new one.

**Tasks:**

- [x] `client/client/chat/chatBus.ts`; `ChatPanel.tsx` subscribes and sends with resources.
- [x] `client/client/widgets/parts.tsx`: Find more through `chatBus`.
- [x] `client/client/chat/chatState.ts`: whitespace-only chunks.
- [x] Tests: `chat/chatBus.test.ts` (queued before a subscriber, sent once); `chatState.test.ts` with chunks recorded from a live master turn (narration, `"\n\n"` between tool cards).

**Acceptance criteria (refresh):**

1. On an open paper, "Find more like this" opens the chat (connecting if needed) and sends "Find more papers like <label>: “<title>”"; the agent's turn starts.
2. A request made before the panel ever opened is sent exactly once when the connection is ready.
3. A recorded live turn with whitespace-only chunks between tool cards renders no empty message bubbles.

## Goal

A panel slides in on the right of the board. The researcher types, and the agent's answer streams in with its plan ticking off, its thoughts dimmed, and one collapsible card per tool call. Stop works, permission requests show Approve and Deny, and papers the agent mentions are clickable.

## Context

- [Architecture diagram 1](../../architecture.html#components): "Chat panel, ACP client" talking ACP over a WebSocket to the ACP pipe.
- [Concept: Product scope, flow 6 "Toggling chat"](../../Concept.md#product-scope) and the event table in [Protocols](../../Concept.md#acp-one-researchers-conversation).
- **Visual spec:** the chat in the [v4 mockup](../../mockups/README.md) (`docs/mockups/flashcard-v4.html`), unchanged in v5 (`flashcard-v5.html`, `shots-v5/9-narrow.png`): top right, "each step shows its model, time and cost", paper names are clickable, and asking a question highlights papers on the board (T06). In v5 the model and time labels stay in the chat; the paper widgets (T10) show none. The v1 shot `docs/mockups/shots/chat.png` is older.
- **Hook in place** on `feat/board-build`: `Room.tsx` mounts `ChatPanel` from `client/client/chat/ChatPanel.tsx` (a stub that renders nothing) beside the canvas, with `{boardId, memberId, editor}`; `editor` is null until the canvas has mounted.

## Scope

**In:** connection and session lifecycle; rendering every ACP update type the harness sends; prompt sending and Stop; permission prompts; paper mentions; disconnect handling; the panel's layout next to the canvas.

**Out:** what goes into a prompt besides the typed text (T07); what `_canvas/*` notifications do (T06; this WP routes them to a handler); chat history across reloads (`session/load` is off in v0).

## Design

**Files** (`client/client/chat/`):

| File | Contents |
| --- | --- |
| `connection.ts` | `openAgentConnection({boardId, memberId, handlers})`: WebSocket stream, ACP client, `initialize` and `session/new`; returns `{prompt(blocks), cancel(), close(), agentInfo}` |
| `chatState.ts` | A pure reducer from ACP updates to the panel's state (tested without a DOM) |
| `ChatPanel.tsx` | Layout, input, Send and Stop, connection banner |
| `AgentMessage.tsx` | Markdown with `paper:` links |
| `ToolCard.tsx`, `PlanList.tsx`, `ThoughtBlock.tsx`, `PermissionPrompt.tsx` | One component per update kind |
| `viewerBus.ts` | A tiny event emitter that `_canvas/*` handlers and paper links publish to; T06 subscribes |
| `client/shared/acpExt.ts` | `zod` schemas for the three `_canvas/*` notifications (shared with tests) |

**Dependencies.** `@agentclientprotocol/sdk@1.8.0`, `zod@4.6.5` (also used by T02), `react-markdown@10.1.0`.

**Connection** (decision D10). The SDK's builder API with its WebSocket stream:

```ts
import * as acp from '@agentclientprotocol/sdk'
import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client'

const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/acp?board=${boardId}&member=${memberId}`
const stream = createWebSocketStream(url)
acp.client({ name: 'paper-canvas' })
  .onRequest(acp.methods.client.session.requestPermission, (ctx) => askInPanel(ctx.params))
  .onNotification(acp.methods.client.session.update, (ctx) => dispatch(ctx.params))
  .onNotification('_canvas/focus', focusParams, (ctx) => viewerBus.emit('focus', ctx.params))
  // _canvas/highlight and _canvas/open_paper the same way
  .onRequest('_canvas/snapshot', snapshotParams, (ctx) => renderSnapshot(editor, ctx.params))  // T07
  .connectWith(stream, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: '/', mcpServers: [canvasServer] })
    expose(ctx, sessionId)  // prompt() and cancel() use ctx until the panel closes
    await untilClosed       // keeps the connection open for the panel's lifetime
  })
```

`connectWith` ends the connection when its callback returns, so the callback waits on a promise resolved by `close()`. Check the exact handler and parser signatures against the SDK's `dist/examples/ws-client.js` in 1.8.0. If the experimental export gives trouble, the fallback is the deprecated `ClientSideConnection` with the 20-line hand-written stream in Concept's snippet; the rest of the panel doesn't change.

- `clientCapabilities` declares no `fs` and no `terminal`: the agent can't touch files.
- `canvasServer` is the HTTP MCP server named `canvas` from the [shared contracts](README.md#shared-contracts): URL `<origin>/api/mcp/canvas/<boardId>`, one header `Authorization: Bearer <memberId>`.
- The connection opens the first time the panel opens, not on page load, so people who never chat never start a harness.

**State and rendering** (`chatState.ts`):

| Update | Panel |
| --- | --- |
| `user_message_chunk` | Ignored (we render the user's message when sending) |
| `agent_message_chunk` | Appended to the current agent message; rendered as Markdown |
| `agent_thought_chunk` | Collapsible dimmed block above the message, collapsed when the message starts |
| `plan` | Checklist pinned at the top of the turn; replaced on every update |
| `tool_call` | New card: title, status icon, and v4's "model, time and cost" line from `_meta` (`model`, `seconds`, `costUsd`), collapsed details |
| `tool_call_update` | Merged into the card by `toolCallId`; failed cards show the error |
| `usage_update` | Token count and the session's running cost (`cost.amount`, `cost.currency`) at the end of the turn |
| anything else | Ignored, logged once to the console |

Tool card details show `rawInput` and `rawOutput` as pretty JSON, truncated in the UI with "show all". Cards whose output names papers or shapes (`added`, `shapeId`) get a "Show on board" button that publishes a local focus.

**Paper mentions.** react-markdown drops unknown URL schemes by default, so pass a `urlTransform` that keeps `paper:` and `https:` and drops everything else, and render `a` elements with `href` starting `paper:` as buttons that publish `focus({paperIds: [id]})` on `viewerBus`. Raw HTML stays disabled.

**Sending and stopping.** Enter sends, Shift+Enter adds a new line. While a prompt is running, Send becomes Stop, which sends `session/cancel`; the turn ends with a small "Stopped" tag when the stop reason is `cancelled`. Other stop reasons (`max_tokens`, `refusal`) show a short explanation.

**Permission requests.** The prompt renders the request's tool title and its options as buttons, replying `{outcome: {outcome: 'selected', optionId}}`; pressing Stop while one is open replies `{outcome: {outcome: 'cancelled'}}`.

**Disconnects.** If the socket closes (harness crashed, idle timeout, server restart), a banner says so with Reconnect, which opens a new connection and a new session. The banner says the conversation starts fresh, since v0 has no resume.

**Layout.** `Room.tsx` already lays out `.Board` as a row: `.Board-canvas` (flex 1, holding `<Tldraw>` and T10's widgets) and `ChatPanel` beside it. The panel is 380 px, collapsible from a header button labelled "Agent". tldraw follows its container's size on its own, and T10's widgets switch to two columns when the panel and the ranked list leave too little room. The panel sits outside the `<Tldraw>` element, so typing in it never triggers canvas shortcuts. The streaming message area is an `aria-live="polite"` region.

## Tasks

- [x] `client/package.json`: the three dependencies above (on `feat/board-build`).
- [ ] `client/shared/acpExt.ts`.
- [ ] `client/client/chat/connection.ts`, tried first against `HARNESS_AGENT=echo`.
- [ ] `ChatPanel.tsx` (replacing the stub), `chatState.ts` with tests; the components; `chat.css` matching the existing `index.css` look.
- [x] `client/client/pages/Room.tsx`: panel next to the canvas (mounted, with `editor` passed in).
- [ ] Header toggle.
- [ ] Root `README.md`: "Chat with the agent" (shared with T03).

## Acceptance criteria

1. Against echo mode, opening the panel starts one harness (seen in the board service log); a message comes back as streamed chunks, the plan shows two steps, and one tool card goes from in progress to completed.
2. With the real harness, Stop during a tool call ends the turn within 2 seconds with "Stopped", and the next prompt works.
3. A message containing `[Title](paper:pmid:1)` renders a button that publishes a focus on `viewerBus`; a `javascript:` link renders as plain text.
4. Killing the harness process shows the disconnect banner; Reconnect gives a working chat.
5. Typing in the panel (including Delete, arrow keys and letters that are tldraw shortcuts) never changes the canvas.
6. Two tabs on the same board have independent chats.

## Tests

- `client/client/chat/chatState.test.ts`: a recorded update sequence (captured from echo mode into a fixture) reduces to the expected state; partial merges of tool cards; plan replacement.
- `client/shared/acpExt.test.ts`: the notification schemas accept the harness's payloads and reject missing `sessionId`.

## Risks

- **Experimental WebSocket stream export** may change between SDK versions: pinned to 1.8.0, with the hand-written fallback above.
- **Long tool outputs** (a full paper record) can slow rendering: details are collapsed and truncated by default.

## References

- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [ACP prompt turn](https://agentclientprotocol.com/protocol/prompt-turn), [tool calls](https://agentclientprotocol.com/protocol/tool-calls), [agent plan](https://agentclientprotocol.com/protocol/agent-plan)
- [react-markdown](https://github.com/remarkjs/react-markdown)
