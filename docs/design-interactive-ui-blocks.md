# Design: Interactive UI Blocks — Bidirectional State, Dockable Surfaces, Quote-Reply

**Status:** Proposal
**Date:** 2026-05-12
**Tracks:** [#131](https://github.com/dfederspiel/clawdad/issues/131)

## Problem

UI blocks emitted by agents (`:::blocks` fences rendered by `web/js/block-parser.js` and `web/js/components/blocks/BlockRenderer.js`) are fire-and-forget surfaces. Once an agent emits a card, a button, a stat, or a table, the rendering is final until the next message replaces it. Three concrete consequences:

1. **No outcome on action buttons.** `ActionBlock.js` fires `/api/action` and mints a portal thread, but the originating button never updates. If the user scrolls back twenty minutes later, every button looks unused — there is no record of "this was clicked," "this succeeded," or "this is in-flight."
2. **Dashboards scroll away.** Triage summaries, deployment status panels, and review checklists are meaningful as long-lived surfaces. Today they slide past as the conversation continues, and the agent has no signal that the user wanted them to remain.
3. **No way to anchor user input to a prior message.** A reply at the bottom of a long conversation is ambiguous when the user is responding to message #38 of 200. The LLM has no signal about which message prompted the reply, and the rendered conversation does not show the linkage.

The goal of this doc is to land all three under one architecture pass, sharing a single concept — **stable element identity** — so each piece reuses the others' primitives rather than reinventing them.

## Design Principle

**State overlays the message, not the message itself.** The lesson from the abandoned `updateMessage()` path (see `CLAUDE.md` "Intermediate Text & Message Streaming") is that mutating `messages.content` is unreliable: ordering bugs on refresh, state leaks across warm-pool queries, and races with the streaming text path. The previous fix — CSS-only message merging — sidestepped the problem by treating messages as immutable.

This design extends the same principle to blocks, pins, and reply edges:

- **Messages are immutable.** Once written, `messages.content` is never updated.
- **Block state lives in a separate table** keyed by `(message_id, block_id)`, merged at render time.
- **Pin state lives in a separate table** keyed by `(jid, message_id, block_id?)`, with optional client-side mirror in `localStorage` (the existing pattern from `portal-persistence.js`).
- **Reply edges live as a new column on `messages`**, written at insert time only.

Every cross-cutting concern (SSE, prompt injection, DB schema) flows from this principle.

---

## Goals

- Bidirectional block state: agents can update a previously-emitted block via a stable ID.
- Dockable messages and blocks: users can pin a surface and the agent is told it's pinned.
- Quote-reply: users can anchor input to a prior message, and the LLM sees the anchor.
- Reuse existing primitives — portals (`threads.kind='portal'`), action buttons, SSE — wherever possible.
- Stay reliable: no mutation of `messages.content`, no client-side-only state for anything that must survive a refresh, no schema choices that block future block types.

## Non-Goals

- A full Slack/Discord-style threading model. Quote-reply is a single-hop anchor; multi-level threads are out of scope for this pass.
- Cross-message block references. A block belongs to exactly one message; updates target `(message_id, block_id)` only.
- Realtime collaborative editing of blocks (form blocks). Forms remain submit-on-action.
- Backwards-compatible block migration. Existing un-ID'd blocks render as today; only new blocks emitted after rollout get IDs and update capability.
- Quote-reply context engineering (token budget tuning, retrieval scoring). Pick a simple ±N window in Phase 1; defer smarter retrieval.

---

## Concepts

### Block Identity

Every block can carry an optional `id` field in its JSON payload:

```json
:::blocks
[
  {
    "type": "action",
    "id": "deploy-confirm",
    "buttons": [
      { "id": "yes", "label": "Deploy", "target": "thread", "target_agent": "deployer" },
      { "id": "no", "label": "Cancel" }
    ]
  }
]
:::
```

If absent at emission, the renderer assigns a content-hash ID at render time (stable across re-renders of the same message). Agents that want to *update* a block later **must** provide an explicit `id` — content-hash IDs are non-addressable from outside the renderer.

Constraints:
- IDs are scoped to the emitting message. `(message_id, block_id)` is the global key.
- IDs are arbitrary strings. The renderer does not validate format beyond non-empty.
- A block ID is *not* a button ID. Buttons inside an `action` block have their own `id` field (already supported today by `ActionBlock.js`).

### Block State Overlay

A new `block_state` table records per-block state without mutating the message:

```sql
CREATE TABLE block_state (
  message_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  state_json TEXT NOT NULL,        -- agent-defined JSON merged into block at render
  updated_at TEXT NOT NULL,        -- ISO-8601
  updated_by TEXT,                 -- 'agent:<name>' or 'system'
  PRIMARY KEY (message_id, block_id)
);
CREATE INDEX block_state_message_idx ON block_state(message_id);
```

`state_json` is shallow-merged over the block payload before rendering. A button block updated with `{ "status": "done", "result": "Deployed in 2m 14s" }` produces a final render that has both its original `buttons` array *and* the new `status`/`result` fields. Renderers decide how to display `status` and `result` for their block type — see "Per-block-type state contracts" below.

Reads:
- `getMessages()` already returns the full conversation; we add an inner query (or a single LEFT JOIN) that pulls `block_state` rows for the message IDs in the page and attaches them as `m.block_state: Record<blockId, stateJson>`.
- The frontend renderer merges `block_state[blockId]` over the parsed block before dispatching to `BlockRenderer`.

Writes:
- A new IPC tool, `update_block`, callable by any agent in a group. Validates that `(message_id, block_id)` exists in a block the *current group* emitted (read from `agent_jid`/`chat_jid` join).
- A new SSE event, `block_state_update`, broadcasts `{ message_id, block_id, state }` so live clients merge without a refetch.

### Portal Pinning (Dockable Surfaces)

The dockable feature is **an extension of portals, not a new primitive.** Portals already give us:

- A `threads.kind` enum (`'trigger' | 'portal'`) — we add `'pin'`.
- A side drawer (`AgentPanel.js`) with stacked panels and a pill-recall affordance (`PortalPill.js`).
- Per-jid persistence in `localStorage` (`portal-persistence.js`).
- Prompt-time awareness: portals are surfaced to the coordinator so the agent knows the surface exists.

A "pin" is a thread with `kind='pin'` that references an existing `(message_id, block_id?)` tuple. The pinned content renders in the drawer the same way a portal renders, but its `body` is a live view of the target block (or message) — re-rendered on `block_state_update` events.

```sql
ALTER TABLE threads ADD COLUMN pin_message_id TEXT;
ALTER TABLE threads ADD COLUMN pin_block_id TEXT;
-- kind='pin' rows MUST have pin_message_id; pin_block_id is optional
```

Pin lifecycle:
1. User clicks "pin" on a message or block (new affordance in `Message.js` / `BlockRenderer.js`).
2. Frontend POSTs to `/api/pins` with `{ jid, message_id, block_id?, title? }`.
3. Orchestrator inserts a `kind='pin'` thread row, broadcasts `thread_created` (existing event), and notifies the next agent run via prompt injection.
4. Drawer renders the pin in the stack alongside any portals.
5. Unpinning deletes the thread row and broadcasts `thread_closed`.

**Agent-awareness contract:** When a pin exists for the current `jid`, the next agent prompt includes a section like:

```text
Pinned surfaces (the user has these visible in a side panel):
- message msg-7c3f... block "deploy-confirm" (action block, "Deploy"/"Cancel")
- message msg-9a14... full message ("Triage summary — 3 alerts")
```

Agents are instructed (in container CLAUDE.md) that when they have new information relevant to a pinned surface, they should call `update_block` to update it in place rather than emitting a fresh duplicate message. **This is a soft contract** — we do not block the agent from emitting redundant blocks. The pin context is a nudge, not a constraint, and the design assumes some agents will ignore it. The fallback path (a new message with similar content) is the current behavior, so the worst case is no-worse-than-today.

### Quote-Reply

A new column on `messages`:

```sql
ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT;
CREATE INDEX messages_reply_to_idx ON messages(reply_to_message_id);
```

`/api/send` accepts an optional `reply_to_message_id`:

```json
POST /api/send
{
  "jid": "web:my-team",
  "content": "Can we re-run this with the staging config?",
  "sender": "David",
  "reply_to_message_id": "msg-7c3fa1b9-..."
}
```

The orchestrator, when preparing the prompt for the next agent run:
1. Loads the quoted message by ID.
2. Loads `N` messages before and `N` messages after the quoted message (default `N=2`, configurable per-group).
3. Prepends a `Quoted context` block to the user message:

```text
Quoted context (the user replied to a specific earlier message):

[2026-05-12 14:03] Andy:
> The three failing tests all hit the staging cluster — likely a TLS rotation issue.

(Surrounding ±2 messages elided here for brevity in the doc; included in actual prompts.)

User reply:
Can we re-run this with the staging config?
```

UI:
- Hover or right-click on a message → "Reply" affordance (analogous to existing "Copy"/"Pin" affordances in `Message.js`).
- Compose box shows a quote chip with the snippet and a dismiss `×`.
- Rendered conversation shows a vertical bar / threading indicator on the reply message, linking visually to the quoted message (anchor scroll on click via the existing `id="msg-{uuid}"` DOM identity).

**Context-bloat guard:** the `±N` window is hard-capped at 5 messages each side AND at a 4000-character total budget for the quoted-context block. If either limit is hit, the window is truncated symmetrically. This is a Phase 1 simplification; smarter retrieval is a follow-up.

---

## Per-Block-Type State Contracts

The block-state overlay is generic, but renderers need to know which fields they honor. Phase 1 contracts:

| Block | State fields | Rendered as |
|---|---|---|
| `action` | `status: 'idle' \| 'pending' \| 'done' \| 'failed'`, `result?: string`, `clicked_button_id?: string` | Buttons gain status badges; clicked button is highlighted; `result` shown below the button row |
| `stat` | `value`, `delta?`, `trend?: 'up' \| 'down' \| 'flat'` | Replaces displayed value, animates the change |
| `progress` | `value: number`, `label?: string`, `done?: boolean` | Updates bar fill and label; `done` collapses to a checkmark |
| `card` | `body?`, `footer?`, `variant?` | Re-renders body/footer; variant changes border color |
| `table` | `rows`, `last_updated_label?` | Full row replacement (small tables only — guard at 100 rows) |
| `alert` | `dismissed?: boolean`, `severity?` | Dismissed alerts collapse; severity changes color |
| `form`, `code`, `diff`, `text`, `sound`, `image` | (Phase 1: not state-aware) | Updates accepted but renderer ignores them |

The contracts are intentionally narrow. Anything not listed is "out of scope for the renderer in Phase 1" — the data goes into `block_state` and a future renderer revision can honor it without a schema change.

---

## Architecture

### Data Flow: Block Update (Bidirectional)

```text
agent process
  └─ mcp__nanoclaw__update_block({ message_id, block_id, state })
     └─ IPC file write → orchestrator
        ├─ validate (message belongs to current group)
        ├─ upsert block_state row
        └─ broadcast `block_state_update` SSE event
           └─ web clients merge state into rendered block
```

Validation lives in the orchestrator, not the container. The container only knows its own `chat_jid` and the IDs it has emitted (which we surface via env or a startup query); enforcement must be host-side to prevent a misbehaving agent from updating another group's blocks.

### Data Flow: Pin

```text
user clicks pin on message/block
  └─ POST /api/pins { jid, message_id, block_id?, title? }
     └─ orchestrator: insert thread (kind='pin')
        ├─ broadcast `thread_created` SSE
        └─ next agent run sees pin in prompt
```

Unpinning is `DELETE /api/pins/:thread_id` with a `thread_closed` broadcast.

### Data Flow: Quote-Reply

```text
user clicks "reply" on message #38
  └─ frontend stores `replyTo = msg-7c3f...` in compose state
     └─ POST /api/send { jid, content, sender, reply_to_message_id }
        └─ orchestrator stores message with reply_to_message_id
           └─ on next agent run, prompt builder injects quoted-context block
```

### IPC Tool: `update_block`

Sibling to `delegate_to_agent`:

```typescript
server.tool(
  'update_block',
  `Update a UI block you previously emitted. Use this when the outcome of an action changes (e.g. a button you emitted is now "Done"), when a stat or progress value advances, or when a card's content is stale.

Pass the message_id from the bot message that contained the block (visible in the conversation via the message metadata) and the block_id you assigned when emitting it. The state object is shallow-merged over the original block — only include fields that changed.

Example: update_block({ message_id: "msg-7c3f...", block_id: "deploy-confirm", state: { status: "done", result: "Deployed in 2m 14s" } })`,
  {
    message_id: z.string(),
    block_id: z.string(),
    state: z.record(z.unknown()),
  },
  async (args) => {
    writeIpcFile(BLOCK_UPDATES_DIR, {
      type: 'block_update',
      messageId: args.message_id,
      blockId: args.block_id,
      state: args.state,
      sourceAgent: process.env.NANOCLAW_AGENT_NAME,
      chatJid,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text', text: `Updated block ${args.block_id} on ${args.message_id}.` }] };
  }
);
```

The IPC handler on the host:
1. Reads the message by ID, verifies `chat_jid` matches the agent's group.
2. Upserts into `block_state`.
3. Broadcasts `block_state_update`.

If validation fails, write an error file to the IPC inbox so the agent gets a tool-error response (existing pattern from `delegate_to_agent`).

### SSE Events

Three additions to the existing event vocabulary:

| Event | Payload | Fired when |
|---|---|---|
| `block_state_update` | `{ message_id, block_id, state, updated_at }` | `block_state` row inserted/updated |
| `pin_created` | `{ jid, thread_id, message_id, block_id?, title? }` | New `kind='pin'` thread inserted |
| `pin_removed` | `{ jid, thread_id }` | Pin thread deleted |

No new SSE event for quote-reply — the standard `message` event carries the new `reply_to_message_id` field.

### Prompt Injection

A new section in the agent-runner prompt assembly, conditional on pinned surfaces or quote-reply being present:

```text
{existing system prompt}

{if pins exist:}
## Pinned surfaces
The user has pinned the following surfaces in a side panel. They are visible to the user throughout the conversation. When you have new information relevant to a pin, prefer calling update_block over emitting a duplicate message.

- {pin1 description}
- {pin2 description}
{endif}

{if reply_to_message_id on the inbound message:}
## Quoted context
{quoted message with ±N window}

User reply:
{user content}
{else:}
{user content}
{endif}
```

This is a small extension to the existing prompt builder. Pins are read from `threads` where `kind='pin' AND chat_jid=?`. Quoted context is computed at prompt-build time.

---

## Phased Rollout

The three features are **independently deployable** by design. Recommended order, smallest user-visible value first:

### Phase 1: Quote-Reply

Smallest schema change, smallest UI change, largest day-to-day UX win.

**Backend:**
- ALTER messages ADD COLUMN reply_to_message_id
- Accept reply_to_message_id on POST /api/send
- Prompt builder: inject quoted-context block with ±2 message window, 4000-char cap

**Frontend:**
- Hover "Reply" affordance on messages
- Quote chip in compose box with dismiss
- Reply indicator on rendered messages with click-to-scroll
- Reuse existing `id="msg-{uuid}"` DOM anchor

**Done when:**
- A user can reply to message #38 of 200; the agent's response references the quoted message; the rendered reply shows the linkage.

### Phase 2: Block State Overlay

The novel piece — sets the pattern for all future bidirectional block work.

**Backend:**
- New `block_state` table + index
- New IPC tool `update_block` (container + handler)
- New SSE event `block_state_update`
- `getMessages()` joins block_state into returned rows

**Frontend:**
- Block parser: respect `id` field, content-hash fallback
- Renderer merges `block_state` overlay
- Per-block-type state contracts (action, stat, progress, card, table, alert)
- New affordances on `ActionBlock` for `status`/`result` display

**Done when:**
- An agent emits an action block with an `id`; user clicks; agent calls `update_block` with `{ status: 'done', result: '...' }`; the original button row updates in place in the UI and stays updated across page refresh.

### Phase 3: Pinning (Dockable Surfaces)

Mostly UI; the backend is a thin extension of portals.

**Backend:**
- threads.kind enum gains `'pin'`
- threads.pin_message_id, threads.pin_block_id columns
- POST /api/pins, DELETE /api/pins/:thread_id
- Prompt builder reads pins from threads, injects "Pinned surfaces" section
- SSE: pin_created, pin_removed (or reuse thread_created/thread_closed)

**Frontend:**
- Pin affordance on Message and on individual blocks
- Drawer renders `kind='pin'` threads alongside portals; pinned blocks re-render on `block_state_update`
- Pin persistence in the existing `portal-persistence.js` model (already per-jid + survives refresh)

**Done when:**
- A user pins a triage card; the card persists in the side drawer; an agent calls `update_block` and the pinned card updates without a new message being emitted; refresh preserves the pin.

---

## Risks and Mitigations

### Risk: `block_state` table grows unboundedly

Mitigation: bounded by message count. Each message has finite blocks, each block has a single state row (upsert, not append). A cap of "delete block_state rows for messages older than 90 days" can run with the existing DB maintenance job if it ever matters; at expected volumes (thousands of blocks per group per month) the table stays small.

### Risk: Agents ignore pin context and emit duplicate messages anyway

Accepted. Pins are a nudge, not a constraint. The fallback is the current behavior. We can tighten the prompt language over time and measure whether agents respect pins (via a simple "did the agent call update_block within N seconds of new information about the pinned surface" metric).

### Risk: Quote-reply context bloat

Mitigation: hard cap on ±N window (5 each side) AND total character budget (4000 chars). Token-aware budgeting is a follow-up; the simple character cap covers the 99% case.

### Risk: Block ID collisions within a message

Mitigation: validated at IPC handler time. If an agent emits two blocks with the same `id` in one message, the renderer treats them as a single addressable surface — updates apply to both visually (likely user-visible bug). Document the constraint in container CLAUDE.md and surface a warning in the parser when a duplicate `id` is detected.

### Risk: The `update_block` tool is misused for content that should be a new message

Mitigation: the tool description and container CLAUDE.md draw the line — `update_block` is for *updating the same surface*, not for delivering new information that warrants its own message. We accept that some agents will over-use it; the rendered output (state badges on old buttons) makes the failure mode visible to the user.

### Risk: Pins and parallel agent runs

If two agents both have new information about a pinned surface, they race on `update_block`. The last write wins (single state row per block). This is the expected behavior for a key-value overlay; we do not attempt CRDT semantics in Phase 1. If a coordinator wants to serialize updates, it can delegate to specialists sequentially.

### Risk: Reverting Phase 2 leaves orphan IDs in agent prompts

If we roll back Phase 2 while agents continue emitting `id` fields, the renderer ignores them (existing behavior — extra fields on block payloads are passed through). The migration is forward-compatible.

---

## Open Questions

- **Should `update_block` be coordinator-only, or available to all agents?** Default to all agents — specialists are often the right author of an update. Revisit if this causes confusion in multi-agent groups.
- **Pin → portal conversion.** If a user pins a block that itself has an `action` button with `target: "thread"`, clicking the button opens a portal. Should the portal output also update the pinned block? Phase 3 says no — they remain separate surfaces — but the UX may want a connection.
- **Quote-reply across pinned content.** Can a user quote-reply *to* a pinned surface, or only to messages in the main conversation? Default to messages only in Phase 1.
- **Mobile / narrow viewports.** Pinning is a desktop affordance. On narrow viewports, the drawer collapses to a top-of-conversation strip or is hidden behind a button. UX detail for Phase 3, not architecture.

---

## Related

- [#131](https://github.com/dfederspiel/clawdad/issues/131) — origin issue
- [#123](https://github.com/dfederspiel/clawdad/issues/123) — unrelated (multi-agent config save UX), despite the cross-reference in #131
- `docs/design-orchestrator-automation-rules.md` — same overlay/non-mutation philosophy applied to routing
- `docs/design-container-activity-feed.md` — the side drawer this design pins into
- `web/js/portal-persistence.js` — the persistence model pinning extends
