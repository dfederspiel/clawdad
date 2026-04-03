# Design: Work-State SSE Telemetry

**Status:** Proposal
**Date:** 2026-04-03
**Updated:** 2026-04-03

## Problem

Today, the UI gets agent activity from two different sources:

- `typing` and `agent_progress` SSE events
- polled `/api/status` snapshots

That split creates visibility gaps.

Example:

1. an agent says "I'm going to work on this"
2. `Thinking...` disappears when generation pauses
3. the container may still be active, idle-waiting, or coordinating delegations
4. the user sees silence until a later message arrives

The backend already knows more than the UI shows. In particular, queue state already tracks:

- `active`
- `idleWaiting`
- `pendingMessages`
- `activeDelegations`
- `pendingDelegationCount`
- task container state

The current UI does not promote that into a conversation-level activity model.

## Design Principle

**Typing is not the same thing as work.**

We should keep typing as a narrow "actively generating output" signal, and add a separate durable work-state stream for:

- orchestration
- waiting
- delegation
- queueing
- background work

## Goals

- Eliminate visibility gaps between "agent started work" and "agent replied"
- Provide accurate per-chat work telemetry to the UI
- Support multi-agent delegation and future automation rules
- Keep the event model provider-neutral for future Anthropic/OpenAI/Ollama runtimes
- Preserve `/api/status` for broad health/admin telemetry

## Non-Goals

- Replacing `typing` SSE
- Building a full trace UI in phase 1
- Capturing every internal token-level detail from every SDK

## Recommendation

Add a new SSE event family:

- `work_state`

This should represent the current durable work state of a chat/group, not just token generation.

Keep:

- `typing` for live response generation
- `agent_progress` for tool/progress snippets
- `/api/status` polling for admin panels and fallback state repair

## Proposed Event Shape

```typescript
type WorkPhase =
  | 'queued'
  | 'thinking'
  | 'working'
  | 'waiting'
  | 'delegating'
  | 'task_running'
  | 'completed'
  | 'error'
  | 'idle';

interface WorkStateEvent {
  jid: string;
  phase: WorkPhase;
  agent_name?: string;
  agent_id?: string;
  summary?: string;
  detail?: string;
  thread_id?: string;
  is_task?: boolean;
  task_id?: string;
  active_delegations?: number;
  pending_delegations?: number;
  pending_messages?: boolean;
  pending_tasks?: number;
  idle_waiting?: boolean;
  container_name?: string | null;
  updated_at: string;
}
```

## Phase Semantics

### `queued`

Use when work exists but has not started yet.

Examples:
- waiting for a global container slot
- message is pending behind current work

### `thinking`

Use only when the agent is actively generating/responding.

This should usually overlap with `typing: true`.

### `working`

Use when the container is active but not currently generating visible output.

Examples:
- post-processing
- performing tool work
- preparing a follow-up

### `waiting`

Use when the container is alive but paused, waiting for IPC input or a dependent result.

This maps naturally to queue `idleWaiting`.

### `delegating`

Use when one or more delegation containers are active or pending.

Include:
- `active_delegations`
- `pending_delegations`

### `task_running`

Use when the active container is executing a scheduled task rather than interactive chat work.

### `completed`

Use for a short-lived terminal transition after work resolves cleanly.

The UI can either:
- show this briefly, then clear to `idle`
- or treat it as ephemeral and collapse immediately

### `error`

Use when the current run failed.

### `idle`

No active or pending work for the chat/group.

## Why SSE Instead of Polling Alone

Polling is still useful, but it is the wrong backbone for accurate transitions.

Polling is weak at:

- short-lived state changes
- delegation start/finish edges
- distinguishing "not typing" from "not working"
- preserving exact ordering of work transitions

SSE gives us:

- transition accuracy
- lower UI inference complexity
- a single semantic stream the UI can trust

## Backend Touchpoints

### 1. Web channel broadcaster

Add a broadcaster in [src/channels/web.ts](/home/david/code/clawdad/src/channels/web.ts):

```typescript
broadcastWorkState(event: WorkStateEvent): void
```

This should mirror the existing `broadcastAgentProgress` and `setTyping` patterns.

### 2. Global helper in runtime entrypoint

Add a helper in [src/index.ts](/home/david/code/clawdad/src/index.ts):

```typescript
function broadcastWorkState(event: WorkStateEvent): void
```

This becomes the central emitter for orchestration/runtime transitions.

### 3. Queue transition emit sites

Primary queue-driven emit sites are in [src/group-queue.ts](/home/david/code/clawdad/src/group-queue.ts):

- `enqueueMessageCheck`
  Emit `queued` if work is blocked behind active work or concurrency limit.

- `enqueueTask`
  Emit `queued` or `task_running` depending on whether the task starts immediately.

- `enqueueDelegation`
  Emit `delegating` when delegations are active or queued.

- `runForGroup`
  Emit `working` when a group container starts.

- `notifyIdle`
  Emit `waiting` when the container enters idle-waiting mode.

- `runTask`
  Emit `task_running` while the scheduled task container is active.

- `drainGroup` / completion paths
  Emit `idle` or `completed` when no more work remains.

### 4. Typing transition bridge

In [src/index.ts](/home/david/code/clawdad/src/index.ts), whenever we currently set typing:

- `setTyping(true)` should usually also emit `thinking`
- `setTyping(false)` should not automatically imply `idle`

That second point is important. A run may stop typing and still be:

- `working`
- `waiting`
- `delegating`

### 5. Delegation runtime emit sites

When delegations start/finish in [src/index.ts](/home/david/code/clawdad/src/index.ts), emit:

- `delegating` on enqueue/start
- updated `delegating` state as counts change
- `working` or `waiting` when control returns to the coordinator

## Frontend Touchpoints

### 1. App-level SSE state

In [web/js/app.js](/home/david/code/clawdad/web/js/app.js), add:

```javascript
export const workStateByJid = signal({});
```

Handle:

```javascript
api.onSSE('work_state', (data) => {
  workStateByJid.value = {
    ...workStateByJid.value,
    [data.jid]: data,
  };
});
```

### 2. Do not clear progress too aggressively

Today, when typing ends, [web/js/app.js](/home/david/code/clawdad/web/js/app.js) clears:

- `typingAgentName`
- `agentProgress`

That is part of the visibility gap.

Phase 1 recommendation:

- keep recent progress/tool history until `work_state.phase` becomes `idle` or a terminal phase ages out

### 3. New chat-level status UI

Add a small `WorkStatusBanner` in:

- [web/js/components/ChatView.js](/home/david/code/clawdad/web/js/components/ChatView.js)
  or
- [web/js/components/MessageList.js](/home/david/code/clawdad/web/js/components/MessageList.js)

Suggested copy:

- `Research Agent is thinking`
- `Research Agent is coordinating 2 agents`
- `Writer is waiting for follow-up work`
- `Task running for this group`
- `Queued behind current work`

### 4. Sidebar/group affordances

Later, [web/js/components/GroupItem.js](/home/david/code/clawdad/web/js/components/GroupItem.js) can use `work_state` for richer labels than just the current thinking dot.

### 5. Status panel integration

[web/js/components/StatusPanel.js](/home/david/code/clawdad/web/js/components/StatusPanel.js) can remain poll-backed at first, but later should consume the same semantic work-state model for consistency.

## Phase 1 Scope

Phase 1 should stay intentionally small:

1. Add `work_state` SSE event
2. Emit from queue start/idle/delegation/completion points
3. Store latest work state per `jid` in the frontend
4. Add a chat-level banner for the selected conversation
5. Stop clearing progress when typing ends if work is still active

This gets us most of the user-facing value quickly.

## Phase 2

Add richer trace detail:

- recent work-state transition history
- visible delegation targets
- automation rule triggers
- optional timestamps/durations

This is where a future "activity trace" panel can come from.

## Phase 3

Unify provider/runtime emitters behind a common telemetry adapter.

This matters for future:

- Anthropic
- OpenAI
- Ollama
- mixed-model agent teams

At that point, runtimes should emit normalized lifecycle events that feed both:

- `typing`
- `work_state`
- `agent_progress`

## Open Questions

### Should `work_state` be event-only or mirrored in `/api/status`?

Recommendation:

- event-first for accuracy
- optional latest-state mirror in `/api/status` for reload recovery

### Should `completed` be visible or collapsed immediately?

Recommendation:

- keep it ephemeral
- show briefly if we want perceived continuity
- otherwise move directly to `idle`

### Should `work_state` be group-level or agent-level?

Recommendation for phase 1:

- group/chat-level event keyed by `jid`

Recommendation for later:

- optionally add nested agent/delegation detail for trace views

## Risks

### 1. State drift

If emit points are incomplete, the UI may still show stale work state.

Mitigation:

- keep `/api/status` polling as a repair mechanism
- derive terminal `idle` when status snapshots prove the group is inactive

### 2. Event spam

Too many work-state transitions could cause noisy rendering.

Mitigation:

- only emit meaningful phase changes
- dedupe identical consecutive states

### 3. Confusion between typing and working

If the copy is poor, users may not understand the distinction.

Mitigation:

- reserve `Thinking...` for active generation
- use separate copy for non-generation states like `Working`, `Coordinating`, and `Waiting`

## Recommendation Summary

Yes, we should add a first-class `work_state` SSE stream.

It is the right backbone if the goal is:

- accurate telemetry
- no visibility gaps
- future support for delegations, automation rules, and mixed runtimes

This is a medium-sized change, not a rewrite:

- backend emit points already exist conceptually
- queue state already tracks most of the needed truth
- the UI mostly needs a new semantic layer above `typing`
