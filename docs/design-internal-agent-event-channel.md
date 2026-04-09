# Design: Internal Agent Event Channel

**Status:** Proposal
**Date:** 2026-04-07
**Updated:** 2026-04-07

## Problem Statement

ClawDad currently uses the shared conversation thread for two different jobs:

1. the **user-facing transcript**
2. the **coordination bus between agents**

That overlap was acceptable when delegation was simple, but it becomes increasingly awkward as the multi-agent system gets faster, more concurrent, and more stateful.

Recent supersession work improved one important failure mode:
- stale specialist output no longer has to surface to the user
- the coordinator can still see a system note that work completed

That makes the current model workable, but it does not change the underlying architectural tension:

**Agent coordination still happens by writing artifacts into the same thread the user reads.**

### Why this matters

This creates several systemic problems:

- **User transcript pollution**: delegation completions, attribution notes, and coordinator narration compete with actual user-relevant content.
- **Weak cancellation semantics**: a result can be suppressed at delivery time, but the system still conceptually treats "agent said something in the thread" as the primary completion path.
- **Coordinator blindness risk**: we now mitigate this with system notes, but awareness is still reconstructed indirectly from chat-visible artifacts instead of a first-class execution record.
- **Double-work pressure**: when an agent result is suppressed, the coordinator must infer whether the completed work is still reusable or whether to re-delegate.
- **Mixed policy boundaries**: the decision "should the user see this?" is entangled with "did the agent complete?" and "should the coordinator know about it?"
- **Harder future features**: precise interrupt/revise, partial synthesis, structured fan-out collection, private peer collaboration, and queue-aware retries all want a non-chat coordination surface.

### Current behavior

Today, the host effectively does this:

```text
specialist completes
  -> maybe send visible message to user thread
  -> store a system note in the conversation
  -> maybe re-trigger coordinator
```

That is a useful bridge design, but the thread is still doing too much work.

### Core question

Should ClawDad continue using the shared conversation transcript as the primary medium for inter-agent coordination, or should it split:

- **internal orchestration state/events**
- **user-visible delivery**

The recommendation in this document is: **split them.**

---

## Design Goal

Introduce a first-class internal event channel for agent execution and coordination, while keeping the shared user transcript as an output surface rather than the source of truth for orchestration.

In the target model:

- specialists complete work into an internal execution record
- coordinators consume structured completion state and artifacts
- the orchestrator decides what, if anything, is delivered to the user
- the user thread remains readable and intentional

---

## Principles

### 1. Completion is not delivery

An agent can complete successfully even if nothing is shown to the user.

### 2. Coordinator awareness is first-class

The coordinator should learn about specialist outcomes from structured internal state, not by inferring from visible system-note breadcrumbs.

### 3. User transcript stays intentional

The chat should optimize for relevance and clarity, not for exposing every internal orchestration step.

### 4. Execution remains centralized

Agents do not gain arbitrary peer transport. The orchestrator still owns validation, queueing, permissions, and delivery decisions.

### 5. Backward compatibility matters

The existing transcript-based behavior should continue to work during migration. This must be an additive architecture change, not a flag day rewrite.

---

## Proposed Architecture

### New concept: internal agent event channel

Create an internal per-chat event stream, persisted by the host, for agent lifecycle and result records.

Examples of event types:

```typescript
type AgentEvent =
  | {
      type: 'agent_run_started';
      chatJid: string;
      agentName: string;
      runId: string;
      batchId?: string;
      triggeredBy: 'user_message' | 'delegation' | 'automation' | 'task';
      parentRunId?: string;
      timestamp: string;
    }
  | {
      type: 'agent_run_completed';
      chatJid: string;
      agentName: string;
      runId: string;
      batchId?: string;
      status: 'success' | 'error' | 'cancelled' | 'superseded';
      outputRef?: string;
      summary?: string;
      timestamp: string;
    }
  | {
      type: 'delivery_decision';
      chatJid: string;
      runId: string;
      decision: 'delivered' | 'suppressed';
      reason:
        | 'fresh'
        | 'superseded_by_newer_context'
        | 'automation_silent'
        | 'coordinator_only';
      timestamp: string;
    };
```

This is not a new peer-to-peer transport. It is an orchestrator-owned event log and state model.

### Separate stores

The system should treat these as different layers:

- **Conversation transcript**: user-visible messages and explicitly visible system notes
- **Internal agent events**: execution facts, completion state, delivery decisions
- **Artifacts/results**: optional richer payloads, files, or structured outputs stored out-of-band

### Coordinator input model

When the coordinator gets a follow-up turn, its context should be built from:

- recent user-visible conversation
- recent internal agent completion events
- references to artifacts or structured specialist outputs

Not every specialist result needs to become a visible system message.

---

## Runtime Flow

### Current model

```text
user message
  -> coordinator delegates
  -> specialist responds into shared thread
  -> host may suppress delivery
  -> host writes system note
  -> coordinator infers what happened from thread history
```

### Proposed model

```text
user message
  -> coordinator delegates
  -> specialist completes
  -> host stores internal completion event + output reference
  -> host applies delivery policy
      -> deliver to user if still relevant
      -> otherwise suppress delivery
  -> coordinator sees structured completion state either way
```

This makes the decision boundary explicit:

- **Did the work complete?**
- **Should the user see it?**
- **Should the coordinator act on it?**

Those are related, but they are not the same question.

---

## Benefits

### Cleaner chat

The user thread contains fewer attribution notes and less orchestration chatter.

### Better supersession

Supersession becomes a delivery policy, not a proxy for whether work "counts."

### Stronger coordinator behavior

The coordinator can reason from explicit specialist completion state instead of guessing from thread artifacts.

### Lower duplicate work

If a specialist finished but was suppressed, the coordinator can reuse that result rather than needlessly re-delegating.

### Better observability

Operators can inspect what ran, what completed, what was suppressed, and why, without scraping the visible conversation.

### Better future cancellation

Interrupt, supersede, retry, and revise semantics become easier when completion and delivery are separate concepts.

---

## Costs And Risks

### More state to model

The host needs to persist and query internal events in addition to messages.

### More prompt-shaping work

Coordinator context construction becomes richer and more selective.

### UI complexity

The web UI may need an optional "internal activity" or trace view so operators can understand hidden-but-completed work.

### Migration risk

There is existing logic that assumes system notes in the transcript are the coordinator-visible record. That cannot all be removed at once.

---

## Migration Plan

### Phase 1: Dual-write internal completion records

Keep current system notes, but also persist structured internal completion/delivery events.

Goal:
- prove the event model
- preserve current behavior
- gain inspectable traces

### Phase 2: Build coordinator context from internal events

Teach the coordinator follow-up path to consume internal completion state directly, while retaining system notes as a fallback.

Goal:
- coordinator awareness no longer depends on transcript breadcrumbs

### Phase 3: Reduce transcript coupling

Stop emitting routine system notes for specialist completions when equivalent internal events exist and the coordinator can already see them.

Goal:
- cleaner user transcript
- less coordination noise

### Phase 4: Add internal-only collaboration features

Once the event channel is real, support more advanced patterns:

- structured fan-out result collection
- cancellation and revise semantics
- coordinator dashboards / traces
- eventually, limited agent-to-agent handoffs without user-thread pollution

---

## Recommendation

Adopt an internal agent event channel as the long-term coordination architecture.

The current supersession work should remain in place because it solves a real user-facing problem now. But it should be treated as a strong transitional layer, not the end state.

Near-term implementation priority:

1. dual-write internal completion and delivery events
2. teach coordinator follow-up to consume them
3. reduce reliance on transcript system notes

This preserves the current robust behavior while moving the architecture toward a cleaner separation between execution, coordination, and user delivery.
