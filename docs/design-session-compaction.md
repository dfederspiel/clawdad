# Design: Session Cost Observability & Future Compaction

> **Status**: Phase 1 (observability) is the active plan. The compaction workflow (Phases 2-4) is deferred until the provider abstraction layer is defined. See "Why compaction is deferred" below.

## Problem

Coordinator sessions grow unbounded. The underlying SDK stores the full conversation transcript and replays it on every turn. Each turn cache-writes the entire session context, and cache writes are the dominant cost.

### Measured data (test-team coordinator, Sonnet, 2026-04-05)

| Metric | Value |
|--------|-------|
| Session file | 1,068 lines, 1.2MB |
| Cache write per turn | ~113K tokens |
| Cache write cost per turn | ~$0.42 (97% of total turn cost) |
| Cache read cost per turn | ~$0.01 |
| Output tokens per turn | 27-131 |
| Total turn cost | ~$0.44 |
| Turns in 24h | ~84 |
| Daily cost (test-team) | ~$27.66 |

The coordinator's session has 328 assistant turns, 271 user turns, and has only compacted once (SDK auto-compact at context limit). Each new turn re-caches the entire growing history.

### Why this matters beyond cost

- **Context pollution**: Old delegation results, stale tool outputs, and resolved conversations dilute the coordinator's attention. It references things "from earlier" that are no longer relevant.
- **UI chatter**: The coordinator narrates based on accumulated context rather than focusing on the current request.
- **Diminishing cache efficiency**: As the session grows, the ratio of new cache writes to cache reads stays high because the tail keeps changing.

## Phase 1: Provider-agnostic cost observability (active plan)

Track context size, replay cost, and growth rate per agent — without coupling to any specific session implementation.

### What to track

| Metric | Source | Provider-neutral? |
|--------|--------|-------------------|
| Cumulative session cost | `agent_runs.cost_usd` sum since last reset | Yes |
| Cost per turn (rolling avg) | Last N runs for the agent | Yes |
| Turn count since reset | Count of `agent_runs` rows | Yes |
| Cache write ratio | `cache_creation_input_tokens / total_input` | Yes (tokens are generic) |
| Context pressure signal | Cost-per-turn exceeding threshold | Yes |

### Context pressure signal

When an agent's rolling cost-per-turn exceeds a configurable threshold, emit a `context_pressure` SSE event:

```json
{
  "type": "context_pressure",
  "agentId": "web_test-team/coordinator",
  "costPerTurn": 0.44,
  "turnsSinceReset": 328,
  "cumulativeCost": 27.66,
  "threshold": 0.30
}
```

The web UI renders this as a dismissible banner with cost breakdown. No action buttons yet — just visibility.

### Implementation

- Add `session_reset_at` column to session tracking (or a simple in-memory map). Defaults to service start time.
- New API endpoint: `GET /api/session/:agentId/pressure` — returns current metrics.
- Emit `context_pressure` SSE when threshold crossed (configurable via env: `CONTEXT_PRESSURE_THRESHOLD=0.30`).
- Web UI: banner component in the chat header area showing cost-per-turn trend.

### What this does NOT include

- No compaction workflow
- No session rotation or manipulation
- No provider-specific session internals (JSONL parsing, session ID rotation)
- No retention policies or summarization

## Why compaction is deferred

A [platform review](./problem-skip-synthesis-default.md) identified that the original compaction design (Phases 2-4) was too tightly coupled to Claude SDK internals:

- Session rotation via SDK session IDs
- JSONL transcript parsing for topic extraction
- SDK-specific compaction hooks
- UI flows built around "rotate + summarize" rather than generic context lifecycle

Multi-provider support is a known future direction. Shipping a compaction workflow now would cement provider-specific behavior into platform APIs, making it expensive to unwind. The right approach is:

1. **Now**: Ship observability (Phase 1) — provider-agnostic, immediately useful
2. **Later**: Define a provider-neutral context lifecycle interface (`analyze → plan → apply → observe`) when the provider abstraction layer exists
3. **Then**: Build compaction as one adapter for that interface, with Claude session rotation as the Claude-specific implementation

### What the future compaction interface might look like

```
ContextLifecycle {
  analyze(agentId): ContextSnapshot     // size, cost, age, topic clusters
  plan(snapshot, policy): RetentionPlan  // what to keep, summarize, archive, drop
  apply(plan): CompactionResult         // execute the plan, return new context handle
  observe(agentId): CostMetrics         // ongoing monitoring (Phase 1)
}
```

Each provider implements `analyze` and `apply` differently:
- Claude SDK: parse JSONL, rotate session ID, inject summary as first message
- OpenAI: manage thread state, trim conversation history
- Local models: truncate context window, inject summary
- Mixed: provider-specific handling per agent

The UI, automation rules, and CLI all consume the same interface.

## Original compaction design (reference only)

The full interactive compaction design — with keep/discard UI, automated policies, and Haiku summarization — is preserved below for reference. It should be revisited once the provider abstraction exists.

<details>
<summary>Deferred Phases 2-4 (click to expand)</summary>

### Phase 2: Interactive compaction UI

A compaction dialog that lets the user choose what to keep:

1. **Session summary** — auto-generated overview of what the agent has done since last compaction
2. **Keep/discard categories:**
   - **Persistent context** — CLAUDE.md, group config (already permanent, surfaced for awareness)
   - **Carry forward** — recent context worth keeping. User selects from conversation threads.
   - **Archive** — written to `conversations/` but removed from active session
   - **Drop** — noise (tool call details, delegation plumbing)
3. **Preview** — estimated post-compaction token count and cost projection
4. **Confirm** — triggers compaction

### Phase 3: Automated compaction policies

```json
{
  "compaction": {
    "auto": true,
    "trigger": { "costPerTurn": 0.30 },
    "retain": { "window": "1h" },
    "summarize": true
  }
}
```

### Phase 4: Smart summarization

Before rotating the session, run a summarization pass with a cheap model to extract: key decisions, user preferences, ongoing tasks, unresolved questions. This summary becomes the preamble of the new session.

### Cost projections (estimated)

| Scenario | Cache write/turn | Cost/turn | Daily (84 turns) |
|----------|-----------------|-----------|-------------------|
| Current (no compaction) | ~113K tokens | ~$0.44 | ~$37 |
| Compact to last 1h (~10 turns) | ~20K tokens | ~$0.08 | ~$7 |
| Compact to summary only | ~5K tokens | ~$0.03 | ~$2.50 |

</details>

## Open questions

- **Session reset as a stopgap**: Users can already get a "poor man's compaction" by deleting the session directory and restarting. Should the UI offer a "reset session" button as an interim measure before proper compaction exists?
- **Memory classes**: The design mixes persistent context (CLAUDE.md), session context (SDK transcript), and archived context (conversations/). The ownership boundaries between these need definition as part of the provider abstraction work.
- **Warm pool interaction**: Any future compaction needs to coordinate with the warm container pool — the pooled container has the old session cached in memory.
