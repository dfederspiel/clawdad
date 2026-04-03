# Design: Orchestrator Automation Rules

**Status:** Proposal
**Date:** 2026-04-03
**Updated:** 2026-04-03

## Problem

Today, most multi-agent routing requires an LLM-mediated step:

```text
message -> coordinator agent -> MCP/tool call -> orchestrator -> target agent
```

This is flexible, but it is not always the right tool:

- some routing is deterministic
- some handoffs are purely mechanical
- some fan-out should happen silently
- some orchestration adds thread chatter without adding user value

This creates three costs:

- **latency** — an extra model turn before useful work starts
- **tokens** — an LLM spends effort deciding something a rule could decide
- **noise** — the thread accumulates operational chatter that is not meaningful to the user

## Design Principle

**Use LLM orchestration for ambiguity. Use orchestrator rules for mechanics.**

The orchestrator should be able to:
- trigger agents deterministically
- perform silent handoffs
- chain common workflows without requiring an LLM to call MCP first

But:
- these actions must remain observable
- loops must be prevented
- the user should still be able to understand why agents woke up

---

## Goals

- Support deterministic routing at orchestrator scope
- Support silent agent wake-ups for low-value operational chatter
- Reduce latency and token spend for common workflows
- Keep the orchestrator as the single execution authority
- Preserve auditability even when actions are hidden from the main chat

## Non-Goals

- Replacing agents with a full workflow engine
- Building a Turing-complete automation system in phase 1
- Removing LLM-driven delegation

---

## Concepts

### Automation Rule

A rule that listens for an orchestrator-visible event and triggers a deterministic action.

Examples of events:
- inbound message
- agent result
- task completion
- thread reply
- schedule firing

Examples of actions:
- delegate to agent
- fan out to multiple agents
- set subtitle
- write a structured system event
- suppress/no-op

### Silent Delegation

A delegation that triggers an agent without posting a visible system message to the main chat timeline.

Important:
- silent does **not** mean untraceable
- it should still appear in logs/debug/trace views

### Trace Event

An internal orchestration record that explains:
- what rule fired
- what action was taken
- which agent was woken
- whether it was silent or visible

---

## Why This Matters

Some workflows should not require a model to decide obvious routing.

Examples:

### 1. Simple mention routing

```text
If a message contains "@review", wake reviewer immediately.
```

No coordinator LLM turn required.

### 2. Mechanical enrichment

```text
When researcher responds, silently wake summarizer.
```

The user may only care about the final synthesized answer.

### 3. Task follow-up

```text
When a scheduled task produces a fresh report, wake writer.
```

This can be deterministic and cheap.

### 4. Known pipeline

```text
research -> validate -> summarize
```

The orchestrator can chain this pipeline without an agent narrating each step.

---

## Proposed Architecture

### Event-driven automation layer

Add an orchestrator-scoped rule engine that evaluates simple rules on events.

```typescript
interface AutomationRule {
  id: string;
  scope: 'group' | 'global';
  when: RuleTrigger;
  then: RuleAction[];
  enabled: boolean;
}
```

### Triggers

```typescript
type RuleTrigger =
  | { event: 'message'; pattern?: string; sender?: 'user' | 'assistant' }
  | { event: 'agent_result'; agent: string; contains?: string }
  | { event: 'task_completed'; taskId?: string; groupFolder?: string }
  | { event: 'thread_reply'; agent?: string }
  | { event: 'scheduled_tick'; ruleId?: string };
```

### Actions

```typescript
type RuleAction =
  | {
      type: 'delegate_to_agent';
      agent: string;
      silent?: boolean;
      messageTemplate?: string;
    }
  | {
      type: 'fan_out';
      agents: string[];
      silent?: boolean;
    }
  | {
      type: 'post_system_note';
      text: string;
      visible?: boolean;
    }
  | {
      type: 'set_subtitle';
      text: string;
    };
```

---

## Execution Model

### Current

```text
event -> LLM decides -> orchestrator executes
```

### Proposed

```text
event -> automation rules evaluate
      -> if matched, orchestrator executes directly
      -> else normal LLM/coordinator path continues
```

This means deterministic rules can short-circuit obvious work without eliminating agent reasoning where it still matters.

---

## Silent vs Visible Orchestration

### Visible delegation

Good for:
- user-facing collaboration
- explanation-heavy workflows
- cases where the handoff itself matters to the user

### Silent delegation

Good for:
- preprocessing
- enrichment
- known fan-out chains
- background quality checks
- low-level operational steps

### Key rule

Silent actions should still generate trace events, even if they do not appear in the main message stream.

Possible surfaces:
- debug log
- task/activity panel
- future orchestration trace UI

---

## Observability Model

Silent orchestration without observability becomes confusing fast.

So every rule execution should emit a structured trace entry:

```typescript
interface OrchestrationTrace {
  id: string;
  timestamp: string;
  groupJid: string;
  sourceEvent: string;
  ruleId: string;
  actionType: string;
  targetAgent?: string;
  silent: boolean;
  outcome: 'queued' | 'skipped' | 'blocked' | 'failed';
}
```

This should be queryable later, even if phase 1 only logs it.

---

## Rule Storage

### Option A: group-config.json

Best fit for early implementation.

```jsonc
{
  "automation": [
    {
      "id": "auto-review",
      "enabled": true,
      "when": {
        "event": "message",
        "pattern": "@review"
      },
      "then": [
        {
          "type": "delegate_to_agent",
          "agent": "reviewer",
          "silent": true
        }
      ]
    }
  ]
}
```

Benefits:
- already group-scoped
- easy to version in git
- human-editable

### Option B: database-backed rules

Better for later UI-heavy editing, but not necessary first.

Recommendation:
- start with `group-config.json`
- add DB/UI management later if adoption is strong

---

## Examples

### 1. Mention-based deterministic routing

```json
{
  "id": "route-review",
  "enabled": true,
  "when": {
    "event": "message",
    "pattern": "@review"
  },
  "then": [
    {
      "type": "delegate_to_agent",
      "agent": "reviewer",
      "silent": false
    }
  ]
}
```

### 2. Silent post-processing

```json
{
  "id": "summarize-research",
  "enabled": true,
  "when": {
    "event": "agent_result",
    "agent": "researcher"
  },
  "then": [
    {
      "type": "delegate_to_agent",
      "agent": "summarizer",
      "silent": true
    }
  ]
}
```

### 3. Task-driven follow-up

```json
{
  "id": "weekly-report-followup",
  "enabled": true,
  "when": {
    "event": "task_completed",
    "taskId": "weekly-report"
  },
  "then": [
    {
      "type": "delegate_to_agent",
      "agent": "writer",
      "silent": true
    }
  ]
}
```

---

## Safety Controls

### 1. Loop prevention

Rules can create accidental cycles:

```text
researcher result -> summarizer
summarizer result -> researcher
```

Mitigations:
- max chain depth
- same-rule cooldown
- trace-based cycle detection

### 2. Rate limiting

Rules that trigger on noisy events need backpressure.

Example:
- only fire once per thread every N seconds

### 3. Allowed target validation

Rules should only target agents that exist and are eligible in that group.

### 4. Silent delegation caps

Too much silent behavior makes the system feel spooky.

Mitigation:
- silent actions stay in trace logs
- optionally summarize hidden activity in a compact visible note later

---

## Relationship to Agent-to-Agent Handoffs

These two systems complement each other:

### Agent-to-agent handoffs

Good when:
- an agent reasons that another agent should act
- the handoff depends on model judgment

### Orchestrator automation rules

Good when:
- the handoff is mechanical or deterministic
- a low-latency rule is sufficient

Together they create a layered orchestration model:

1. deterministic orchestrator rules
2. agent-initiated handoffs
3. coordinator synthesis/final response

---

## Relationship to Mixed Providers

This becomes even more valuable once agents can run on different runtimes.

Example:
- local Ollama classifier decides if work is interesting
- orchestrator silently wakes GPT researcher only when needed
- Opus writer produces final polished answer

That pattern is much better when obvious routing does not consume a premium model turn.

So orchestrator automation is a strong multiplier for:
- per-agent runtime selection
- mixed-model teams
- cost-aware orchestration

---

## Migration Path

### Phase 1: Logging-only rules

1. parse `automation` from `group-config.json`
2. evaluate rules on inbound events
3. emit trace logs only

Goal:
- validate rule shape and observability without affecting behavior

### Phase 2: Deterministic delegation

1. enable `delegate_to_agent`
2. support `silent`
3. add loop prevention and cooldowns

### Phase 3: Group UI

1. surface rules in group drawer/settings
2. show recent automation activity
3. allow enable/disable per rule

### Phase 4: Rich orchestration graph

1. trace viewer
2. hidden activity summaries
3. fan-out and conditional pipelines

---

## Risks

### 1. Over-automation

If too many rules are added, behavior becomes hard to reason about.

Mitigation:
- conservative defaults
- trace visibility
- explicit per-group configuration

### 2. Hidden surprise

Silent delegation can make users feel like agents are waking up mysteriously.

Mitigation:
- silent in chat, not silent in trace

### 3. Rule sprawl

Rules in config can become difficult to manage.

Mitigation:
- start small
- reserve advanced composition for later phases

---

## Recommendation

Add an orchestrator automation layer with:

- deterministic triggers
- silent delegation support
- trace-first observability

This should be treated as:

**a complement to LLM orchestration, not a replacement for it**

The orchestrator handles mechanics.
Agents handle judgment.

That split reduces latency, token spend, and chatter while staying aligned with the current architecture.
