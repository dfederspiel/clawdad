# Design: Agent-to-Agent Handoffs

**Status:** Proposal
**Date:** 2026-04-03
**Updated:** 2026-04-03

## Problem

Today, inter-agent coordination is effectively:

```text
agent -> orchestrator -> agent
```

This works well for safety and traceability, but it is coordinator-centric and can feel heavier than necessary for teams where specialists should be able to hand work to each other more naturally.

Examples:
- researcher wants reviewer input without waiting for coordinator mediation
- writer wants fact-checker confirmation before posting
- local summarizer wants GPT specialist to expand a result

The question is:

**Should agents be able to hand work directly to other agents?**

---

## Design Principle

**Agent-to-agent intent should be direct. Execution should remain centralized.**

That means the system should feel like:

```text
agent -> agent
```

But be implemented as:

```text
agent -> orchestrator dispatch bus -> agent
```

This preserves queue integrity, auditability, and policy enforcement while enabling richer peer collaboration.

---

## Models

### 1. Coordinator mediation only

```text
agent -> coordinator -> orchestrator -> agent
```

Benefits:
- simplest mental model
- strongest central control
- easiest to debug

Costs:
- coordinator becomes a bottleneck
- peer collaboration feels artificial
- specialists cannot initiate handoffs on their own

### 2. Direct-intent, centralized execution

```text
agent -> orchestrator dispatch bus -> target agent
```

Benefits:
- agents can initiate handoffs directly
- orchestrator still owns execution, permissions, and queueing
- user-visible trail remains intact
- fits current architecture well

Costs:
- requires a new message/event type
- needs loop prevention and dispatch policy
- more complex than coordinator-only model

### 3. True direct agent transport

```text
agent -> agent
```

Benefits:
- lowest-latency peer collaboration
- most flexible emergent team behavior

Costs:
- hardest to reason about
- hidden communication paths
- queue/concurrency corruption risk
- difficult usage attribution
- difficult permission boundaries
- high loop risk

---

## Recommendation

Do **not** jump straight to true direct transport.

The recommended next step is:

**Support agent-initiated handoffs with orchestrator-mediated execution.**

This gives most of the benefit of agent-to-agent collaboration without losing:
- queue safety
- visibility
- permission enforcement
- scheduling discipline
- debugging clarity

---

## Proposed Architecture

### New concept: handoff event

An agent can emit a handoff request:

```typescript
interface AgentHandoffRequest {
  fromAgentId: string;
  toAgentName: string;
  message: string;
  threadId?: string;
  reason?: string;
}
```

This is not a direct socket or IPC line to another agent.

Instead:
1. source agent emits a handoff request
2. orchestrator validates it
3. orchestrator stores a visible handoff record
4. orchestrator enqueues the target agent
5. target agent receives the request as structured context

---

## User-visible behavior

### Chat transcript

Handoffs should be visible in the shared group chat.

Example:

```text
[10:30] Researcher: I found three likely causes. Handing this to Reviewer for validation.
[10:30] System: Researcher delegated to Reviewer
[10:31] Reviewer: The second cause looks correct. I recommend proceeding with that.
```

This keeps the group chat as the source of truth.

### Why visible handoffs matter

Without visible handoffs:
- the user can’t tell why an agent woke up
- debugging becomes difficult
- loops become opaque
- the team feels magical instead of understandable

---

## Runtime Flow

### Proposed dispatch flow

```text
1. Agent A emits delegate_to_agent("reviewer", "Validate these findings")
2. Orchestrator receives the request
3. Orchestrator validates:
   - target exists
   - sender is allowed to delegate
   - hop limit not exceeded
   - no disallowed cycle
4. Orchestrator stores a handoff/system event in the chat
5. Orchestrator enqueues Agent B
6. Agent B receives:
   - original request
   - source agent identity
   - recent group/thread context
7. Agent B responds in normal chat flow
```

### Important point

This is still:

```text
agent -> orchestrator -> agent
```

at the execution layer, but:

```text
agent -> agent
```

at the intent layer.

That distinction is what keeps the system manageable.

---

## Policy Controls

### 1. Delegation permission

Not every agent should necessarily be allowed to hand off.

Possible rule:
- coordinators: always allowed
- specialists: optionally allowed

Future config:

```json
{
  "handoffs": {
    "canDelegate": true
  }
}
```

### 2. Target allowlist

Some agents may only be allowed to delegate to certain peers.

Example:

```json
{
  "handoffs": {
    "allowedTargets": ["reviewer", "researcher"]
  }
}
```

### 3. Hop limit

Prevent runaway chains:

```text
A -> B -> C -> D -> ...
```

Suggested metadata:

```typescript
handoffDepth: number
```

Stop or require coordinator intervention beyond a threshold.

### 4. Cycle detection

Detect obvious loops:

```text
A -> B -> A
```

or:

```text
A -> B -> C -> A
```

Even simple recent-history detection would help significantly.

---

## Relationship to Current Delegation

Today, the coordinator pattern is already close to this idea:
- coordinator can delegate
- target agent runs later
- response appears in chat

The proposed change is not a new transport layer.

It is:
- expanding who can initiate delegation
- making handoffs a first-class concept instead of a coordinator-only behavior

This suggests a natural migration:

### Phase 1

Coordinator-only delegation remains as-is

### Phase 2

Allow selected specialists to use the same handoff mechanism

### Phase 3

Add richer policies, logs, and UI around handoff graphs

---

## Interaction with Mixed Providers

This becomes more important once agents can run on different runtimes:
- Anthropic coordinator
- OpenAI researcher
- Ollama summarizer

In that world, a centralized dispatch layer is even more valuable because it normalizes:
- permissions
- tracing
- retries
- failure handling
- usage attribution

True direct peer transport across runtimes would be much more fragile.

So this design pairs well with:
- per-agent runtime selection
- mixed-model teams

---

## UI Opportunities

### Group chat

Show handoff system messages inline.

### Future team graph

Visualize:
- who handed off to whom
- which agents are bottlenecks
- which handoffs fail often

### Group settings

Potential future controls:
- can this agent delegate?
- allowed targets
- max handoff depth

---

## Risks

### 1. Hidden complexity

Even with centralized execution, agent-initiated handoffs can make workflows harder to predict.

Mitigation:
- keep handoffs visible
- keep default permissions conservative

### 2. Looping behavior

Peer delegation creates more opportunities for runaway chains.

Mitigation:
- hop limit
- cycle detection
- rate limiting

### 3. Prompt bloat

If every handoff drags too much context, prompts can get expensive and noisy.

Mitigation:
- handoff payload should be concise and structured
- include only relevant recent context

### 4. Ownership ambiguity

If many specialists can delegate, it can become unclear who is actually responsible for the final answer.

Mitigation:
- preserve the concept of a coordinator/final responder even when peers collaborate

---

## Recommendation

The right next step is:

**agent-initiated handoffs, orchestrator-mediated execution**

Not:

**raw direct agent-to-agent transport**

This gives the system:
- more natural specialist collaboration
- lower coordinator friction
- better future compatibility with mixed runtimes

while preserving:
- queue integrity
- visibility
- policy enforcement
- debuggability

That makes it a strong fit for the current architecture and a safe evolution path from today's delegation model.
