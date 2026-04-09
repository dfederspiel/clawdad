# Plan: Orchestrator Optimization

**Status:** Active
**Date:** 2026-04-03
**Revised:** 2026-04-03 (post-review)

## Where We Are

The orchestrator works. Multi-agent groups run, delegations fan out in parallel, automation rules (Phase 1) log correctly. But it's expensive:

- **test-team burned $27 in 2 days** — 172 runs at ~$0.16 each
- Every user message can spawn 2-5 containers (coordinator + specialists)
- Every container cold-starts a fresh Claude session (6.4M cache write tokens in 24h)
- Containers either block the orchestrator (piping loop) or exit immediately (delegations) — no middle ground
- The coordinator often runs an LLM turn to decide routing for messages that could be dispatched deterministically

Note: explicit @-mention routing is already partially optimized — specialist triggers are detected directly in `processGroupMessages`, so we are not starting from a blank slate. But the current trigger selection still includes the triggerless group agent/coordinator in some cases, so this is not yet a pure "specialist only, no coordinator involvement" path. The bigger waste is still in natural-language routing where the coordinator decides who should handle a message, post-agent-result chaining, and task follow-up fan-out.

The core problem: **containers are disposable, sessions are ephemeral, and the orchestrator uses LLM turns for mechanical decisions.**

## Design Constraints

1. **No competing systems** — each change must extend the current architecture, not fork it. The queue, IPC, and session model stay; we make them smarter.
2. **No racing** — warm containers and async lifecycle create new concurrency surfaces. The queue already serializes per-group work; we preserve that invariant.
3. **Observable** — silent optimization is debugging hell. Work-state telemetry ships alongside or ahead of lifecycle changes so we can see what's happening.

## The Three Layers

These are not independent features — they're three layers of the same optimization, ordered by dependency:

```
Layer 1: Warm Containers        (stop paying for cold starts)
Layer 2: Deterministic Routing   (stop paying for mechanical LLM decisions)
Layer 3: Multi-Provider Runtime  (stop paying premium rates for commodity work)
```

Each layer multiplies the savings of the ones below it. Multi-provider without warm containers just means cold-starting cheaper models. Deterministic routing without warm containers still cold-starts the target agent. Warm containers alone cut the per-run cache cost but don't reduce run count.

The right order is 1 → 2 → 3, but the work can overlap.

### New Cross-Cutting Track: Internal Agent Event Channel

Recent delegation and supersession work fixed an important user-facing problem: stale specialist output no longer has to clutter the thread. But it also made a larger architectural boundary visible.

Today the shared conversation still acts as both:
- the user-visible transcript
- the coordination bus between agents

That is increasingly awkward as delegation gets more concurrent, more pooled, and more cancellation-aware. We now have delivery-time suppression and coordinator-visible completion notes, which is a good bridge, but the cleaner long-term model is to separate:

- **internal agent execution events**
- **user-visible message delivery**

This should be treated as a cross-cutting roadmap item that sits underneath Layers 1 and 2:

- warm containers increase the value of precise interrupt/revise semantics
- deterministic routing increases fan-out and coordination volume
- both become easier to reason about if coordinator awareness does not depend on user-thread artifacts

Design doc: `docs/design-internal-agent-event-channel.md`

Near-term roadmap for this track:
- Phase 1: dual-write internal completion and delivery events alongside current system notes
- Phase 2: build coordinator follow-up context from internal events rather than transcript breadcrumbs
- Phase 3: reduce routine specialist completion notes in the visible thread

This is not a replacement for the current supersession work. It is the architectural continuation of it.

---

## Layer 1: Warm Container Pool

### Problem

Today's container lifecycle:

```
message → spawn container → cold start SDK → load session → respond → idle loop (blocks orchestrator) or exit
next message → spawn again → cold start again → reload session → cache write again
```

`runContainerAgent` returns a promise that doesn't resolve until the container exits (the `close` event in `container-runner.ts:642`). The orchestrator can either:
- Block on the piping loop (non-delegation containers) — occupies the queue slot
- Exit immediately (delegations) — loses the warm session

Neither option allows reuse.

### Target

```
message → check pool for warm container → found? route to it (cache hit) : spawn new
respond → return to pool (idle, not blocking queue) → available for next message
idle timeout → container exits, reclaimed
```

### Scope: Coordinator First, Then Specialists

Phase B warms **the coordinator container per group**. This avoids the IPC ownership problem (see below) while capturing the biggest initial cache savings — the coordinator handles the most traffic and has the richest context to reload.

Phase B.1 extends warmth to **specialist containers** by introducing per-container IPC namespaces. Specialists warm on first use and stay warm if reused within a configurable idle window. A specialist called once warms briefly and reclaims. A specialist called repeatedly stays warm — no wasted RAM, no repeated cold starts.

### The IPC Ownership Problem

Today, IPC uses a single per-group namespace:

```
/workspace/ipc/{group_folder}/input/    ← one directory per group
```

The queue writes to it (`group-queue.ts:184`), the close sentinel targets it (`group-queue.ts:205`), and the agent-runner polls it (`agent-runner/src/index.ts:76`). There is no agent or container dimension.

This works today because only one container is alive per group at a time (the coordinator, or a single delegation). But keeping multiple warm containers for the same group would create ambiguity: which container should read from `/workspace/ipc/input/`?

**Resolution for Phase 1 (coordinator-only pool):** Not an issue. One warm coordinator per group means one IPC reader per group, same as today. The coordinator owns the group's IPC namespace.

**Resolution for specialist warmth (Phase B.1): Per-container IPC namespace.** Mount `/workspace/ipc/{group_folder}/{container_id}/input/` on the host side. Inside the container, the path stays `/workspace/ipc/input/` — the agent-runner code doesn't change, only which host directory gets mounted. The pool manager writes messages to the correct container's namespace. Requires changing mount paths in `container-runner.ts` and the IPC write paths in `group-queue.ts`.

Important: `input/` is not the only IPC surface. Today the host also processes group-scoped `delegations/`, `achievements/`, and `credentials/` directories under `DATA_DIR/ipc/{group_folder}/...`. Those are fine to remain group-owned because they are consumed by the host watcher, not by a specific warm container. But any new per-container lifecycle artifacts introduced by pooling, such as session sync files or container heartbeats, should live under the per-container namespace rather than the shared group root.

### Key Changes

**1. Rewrite process ownership in container-runner**

This is not a small refactor. Today the host's relationship with a container is:

- Spawn child process
- Write JSON to stdin, close stdin
- Parse stdout markers (`OUTPUT_START`, `PROGRESS_START`)
- Resolve promise on `close` event

The host has no way to send a second prompt to a running container except through IPC file polling (which is what the piping loop does, blocking the orchestrator).

For warm containers, the host must **retain and coordinate long-lived child processes**:

- Spawn container, write initial prompt to stdin
- Parse first response from stdout markers → resolve the **query** promise (not the container promise)
- Container enters idle state, host retains the `ChildProcess` reference
- On next query: write IPC message to the container's input directory
- Parse next response from stdout → resolve the next query promise
- On reclaim: write `_close` sentinel, wait for process exit

This means `runContainerAgent` splits into two functions:

```typescript
// Spawns container, runs first query, returns handle + result
async function spawnAndQuery(
  group, input, onOutput, onProgress
): Promise<{ result: ContainerOutput; handle: ContainerHandle }>

// Sends follow-up query to an existing container
async function queryWarmContainer(
  handle: ContainerHandle, prompt: string, onOutput, onProgress
): Promise<ContainerOutput>

interface ContainerHandle {
  containerName: string;
  process: ChildProcess;
  groupFolder: string;
  agentId: string;
  sessionId: string;
  // stdout is still being parsed — the handle keeps the parser alive
}
```

The original `runContainerAgent` remains as a convenience wrapper for one-shot containers (delegations, tasks) that spawns, queries, and reclaims in one call.

**2. Container pool manager (new: `src/container-pool.ts`)**

Tracks warm coordinator containers by group:

```typescript
interface PoolEntry {
  handle: ContainerHandle;
  groupFolder: string;
  idleSince: number;
  state: 'busy' | 'idle';
}
```

Operations:
- `acquire(groupFolder)` — return warm container if available, or null. Atomically sets state to busy.
- `release(groupFolder)` — mark container idle, start idle timer.
- `reclaim(groupFolder)` — send `_close`, wait for exit, remove from pool.
- `reclaimAll()` — graceful shutdown for all warm containers.

Idle timeout: configurable per-group (default 5 minutes for coordinators). Much shorter than today's 30-minute hard timeout.

**3. Session ID sync via IPC**

Today the session ID only flows back to the host when the container exits (via `ContainerOutput.newSessionId`). For pool reuse, the agent-runner writes the session ID to an IPC file after each query completes:

Coordinator-only Phase B:

```
/workspace/ipc/{group_folder}/session.json  →  { "sessionId": "...", "agentId": "default" }
```

Specialist warmth Phase B.1:

```
/workspace/ipc/{group_folder}/{container_id}/session.json
  →  { "sessionId": "...", "agentId": "analyst" }
```

The pool reads this when a container goes idle, so it knows what session the warm container holds.

**4. Queue integration**

The queue's `GroupState` gains awareness of the pool. Key changes:
- `notifyIdle` no longer means "container is blocking in piping loop" — it means "container returned to pool"
- `closeStdin` targets the pool's reclaim path instead of writing the sentinel directly
- Active container count: busy pool containers count against `MAX_CONCURRENT_CONTAINERS`, idle ones don't

**5. Concurrency budget**

```
MAX_CONCURRENT_CONTAINERS = 3  (active work)
MAX_WARM_CONTAINERS = 5        (idle in pool, cheap to keep)
```

When the active budget is full, new work queues as today. When a container finishes, it moves from active to warm budget. If the warm budget is full, the least-recently-used container is reclaimed.

### Racing Concerns

- **Per-group serialization preserved** — the queue still serializes message processing per group. A warm container for group X only receives work when group X's queue slot runs.
- **Container assignment is atomic** — `acquire()` atomically marks the container busy and removes it from the idle set. No two queue runs can grab the same container.
- **IPC directory isolation preserved (coordinator-only)** — one warm coordinator per group means one IPC reader, same as today. No ambiguity.
- **Stdout parsing continuity** — the `ContainerHandle` keeps the stdout parser alive across queries. Each `OUTPUT_START`/`OUTPUT_END` pair routes to the correct query's callback.

### Known Bug Addressed: Idle Container Self-Triggering

Today, idle containers sit in `waitForIpcMessage()` polling the IPC input directory. The message loop's piping path sees the container's own `send_message` output land in the DB as a new message, then pipes it back to the same container via IPC. The container wakes up and processes its own output as new user input.

The warm pool should let us remove the current DB-driven piping path that makes this possible, but pooling alone does not automatically eliminate it. Warm containers still sit in the agent-runner query loop and wait for IPC input between turns. So the real fix is:

1. make the pool the sole owner of follow-up delivery
2. retire the existing ambient piping path that re-injects DB messages into an already-live container
3. ensure follow-up prompts are explicitly authored/filtered by the orchestrator before they reach IPC

Once that older piping path is gone, self-triggering should become structurally impossible. Until then, pooling only reduces the surface area of the bug.

### What This Does NOT Change

- The IPC file-based protocol (proven, works across container boundary)
- The session directory mount structure
- The `ContainerInput`/`ContainerOutput` interfaces (extended, not replaced)
- The delegation model (delegations still exit immediately — they're one-shot by design)

### Relationship to Work-State SSE Telemetry

The warm container pool creates new lifecycle states the UI should reflect:

- `idle` (in pool, available) — shown in sidebar as a warm indicator
- `busy` (processing query) — shown as thinking/working
- `reclaiming` (shutting down) — transient

The `work_state` SSE event from the telemetry design doc is the right vehicle. Phase 1 of warm containers should emit work-state events even if the UI doesn't consume them yet — this gives us observability from day one.

### Relationship to Private Agent Workspaces

Warm containers make private workspaces nearly free. If a user clicks into an agent's workspace, we route to the warm container (or spawn one). The session is already loaded, context is cached. Without warm containers, every workspace interaction is a cold start.

Private workspaces are a separate feature, but they become practical once containers stay warm.

---

## Layer 2: Deterministic Routing (Automation Rules Phase 2)

### Problem

Phase 1 proved the rule schema works. Rules evaluate correctly on messages, agent results, and task completions. But they only log — the coordinator still mediates every interaction where explicit @-mention triggers don't match.

**What the existing router already handles:** explicit trigger detection. `@analyst check this` already matches the analyst via trigger pattern matching in `processGroupMessages`. This means explicit specialist invocation is already more efficient than pure coordinator mediation. But because the triggerless group agent/coordinator can still be selected in the same routing pass, it is not yet a strict "specialist-only, zero coordinator involvement" path.

**What automation rules target:** the cases the existing router can't handle deterministically:

1. **Coordinator-only natural-language routing** — "Can someone check the latest numbers?" has no @-mention, so it goes to the coordinator, who spends an LLM turn deciding to delegate to the analyst. A rule could match on content patterns and route directly.

2. **Post-agent-result chaining** — when the researcher finishes, the summarizer should always run next. Today this requires the coordinator to wake up, read the researcher's output, and decide to delegate. A rule can chain this mechanically.

3. **Task follow-up fan-out** — when a scheduled task completes, wake a specific agent to process the result. Today this requires either a new user message or a coordinator turn.

4. **Silent preprocessing** — enrichment or validation steps that don't need to appear in the chat timeline.

### Target

```
untriggered message + rule match → specialist wakes directly, coordinator skipped
agent result + rule match → next agent wakes automatically
task completion + rule match → follow-up agent wakes
```

### Key Changes

**1. Rule execution engine**

Extend `evaluateAutomationRules` to return matched actions instead of just logging. The orchestrator checks rules before entering the normal routing path:

```typescript
const fired = executeAutomationRules(group.folder, event);
if (fired.length > 0) {
  // Rules handled it — skip coordinator
  for (const action of fired) {
    if (action.type === 'delegate_to_agent') {
      queue.enqueueDelegation(chatJid, taskId, () => runAgent(group, prompt, chatJid, ...));
    }
    if (action.type === 'fan_out') {
      for (const agent of action.agents) { /* parallel delegation */ }
    }
  }
  return true;  // Don't fall through to coordinator
}
// No rules matched — normal coordinator/trigger path
```

**Important:** rule execution runs *after* the existing trigger-based routing check. If an @-mention trigger matches, that takes priority (it's already fast and correct). Rules only intercept messages that would otherwise go to the coordinator for LLM-based routing.

**2. Silent delegation support**

Rules with `silent: true` skip the system message (`[Agent has responded above.]`). The response still appears in chat, but the orchestration chatter doesn't. This reduces noise for known pipelines (e.g., `researcher → summarizer`).

**3. Safety controls**

- **Max chain depth (default: 3)** — prevents `A → B → A → B` loops. Track rule fire count per event chain.
- **Cooldown per rule (default: 5 seconds)** — same rule can't fire twice in rapid succession for the same group.
- **Target validation** — rule can only delegate to agents that exist in the group. Validated at load time.

**4. Coordinator bypass vs. coordinator deferral**

Two modes for rules that fire on messages:

- **Bypass** (default for `silent: true`): coordinator never wakes. Best for known deterministic routes.
- **Deferral**: specialist runs first, coordinator wakes after to synthesize. Best for when the coordinator adds value to the specialist's output.

The existing delegation completion mechanism (`enqueueMessageCheck` after all delegations finish) already supports deferral — we just skip the coordinator's initial turn.

### Integration with Warm Containers

Deterministic routing + warm containers = fast. The rule fires, the pool has a warm coordinator (or in the future, warm specialist), the agent responds from cache. No LLM routing decision, minimal cache writes.

---

## Layer 3: Multi-Provider Runtime

### Problem

Every agent runs Claude via the Claude Agent SDK. The SDK is excellent but it means every agent turn costs Anthropic API rates. Many agent tasks don't need Opus — or even Claude:

- A triage classifier: "does this message need a specialist?" → small local model
- A format converter: "turn this JSON into markdown" → fast cheap model
- A PR reviewer: "check for common issues" → mid-tier model
- A creative writer: "draft a blog post" → premium model

### Target

Per-agent runtime selection in `agent.json`:

```json
{
  "displayName": "Classifier",
  "trigger": "@classify",
  "runtime": {
    "provider": "ollama",
    "model": "llama3.2:3b"
  }
}
```

### The Abstraction Boundary

The naive interface — `AgentRuntime.query(prompt, sessionId?)` — is too thin. The current agent-runner depends on the Claude SDK for much more than query/response:

- **MCP server wiring** — the SDK manages MCP tool servers (`agent-runner/src/index.ts:488`)
- **Progress/tool events** — streamed via SDK message callbacks (`agent-runner/src/index.ts:514`)
- **Session anchoring and resume** — SDK-native session management (`agent-runner/src/index.ts:533`)
- **Hooks and slash commands** — SDK-level features that other runtimes won't have
- **Multi-turn MessageStream** — keeps the SDK iterator alive for agent teams

The real abstraction boundary is **runtime session + lifecycle events**, not a simple query function:

```typescript
interface AgentRuntime {
  // Session lifecycle
  createSession(config: RuntimeConfig): Promise<RuntimeSession>;
  resumeSession(sessionId: string, config: RuntimeConfig): Promise<RuntimeSession>;

  // Query with full event stream
  query(session: RuntimeSession, prompt: string): AsyncIterable<RuntimeEvent>;

  // Capability declaration
  capabilities: {
    supportsMcp: boolean;
    supportsResume: boolean;
    supportsHooks: boolean;
    supportsMultiTurn: boolean;
    supportsToolUse: boolean;
  };
}

type RuntimeEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; output: unknown }
  | { type: 'progress'; summary: string }
  | { type: 'usage'; data: UsageData }
  | { type: 'complete'; sessionId: string }
  | { type: 'error'; message: string };
```

This allows:
- `ClaudeAgentRuntime` — full SDK features, MCP, sessions, hooks
- `OllamaRuntime` — query + text events only, no MCP, no sessions
- `OpenAIRuntime` — query + tool_use events, limited session support

The orchestrator adapts behavior based on declared capabilities — e.g., don't delegate MCP-heavy work to an Ollama agent.

### Key Changes

**1. Extract ClaudeAgentRuntime from current agent-runner**

Factor out the Claude SDK interaction into a `ClaudeAgentRuntime` class that implements the interface above. The existing agent-runner becomes a thin shell that instantiates the appropriate runtime and pipes `RuntimeEvent`s to stdout markers.

**2. Add OllamaRuntime — simplest second provider**

Local Ollama models via HTTP API. No auth complexity, no session management. A good proving ground for the runtime interface.

**3. Runtime selection in container startup**

The container-runner reads `runtime` from `agent.json` and passes it as part of `ContainerInput`. The agent-runner instantiates the appropriate runtime.

**4. Credential proxy extension**

The credential proxy already handles Anthropic auth. Extend it to proxy other providers:

```
/forward/ollama   → local Ollama endpoint
/forward/openai   → OpenAI API (key from .env)
```

Containers never see real credentials for any provider.

### Integration with Warm Containers

Ollama containers are nearly free to keep warm — the model is loaded locally, there's no API cost for idle time. This makes the "local classifier + premium executor" pattern viable:

```
message → warm Ollama classifier (instant, free) → "needs deep analysis" → warm Opus coordinator (cache hit, fast)
```

### Integration with Automation Rules

Rules can select targets by capability. A rule that fires on `agent_result` from the classifier can route to different agents based on the result content:

```json
{
  "id": "route-by-classification",
  "when": { "event": "agent_result", "agent": "classifier", "contains": "DEEP_ANALYSIS" },
  "then": [{ "type": "delegate_to_agent", "agent": "analyst", "silent": true }]
}
```

---

## Implementation Sequence

### Phase A: Observability Foundation (1-2 days)

Before optimizing the lifecycle, make it visible.

1. Add `work_state` SSE event type and `broadcastWorkState` helper
2. Emit from existing queue transition points (queued, working, delegating, idle)
3. Frontend: store `workStateByJid` signal, add chat-level status banner
4. Add tool-level cost visibility — persist per-tool token usage from agent runs and surface in the telemetry panel and per-message usage footer. This creates a natural feedback loop: users see which tools are expensive, agents/orchestrators can use the data to adapt behavior over time. Visibility, not control — no truncation or gates.
5. This gives us baseline visibility for everything that follows

### Phase B: Warm Coordinator Pool (3-5 days)

The biggest architectural change. Coordinator-only scope keeps IPC ownership simple — one warm container per group, one IPC reader, no ambiguity.

1. Rewrite `runContainerAgent` into `spawnAndQuery` + `queryWarmContainer` + `ContainerHandle`
2. Modify agent-runner to write session ID to IPC after each query
3. Create `src/container-pool.ts` — pool manager with acquire/release/reclaim (coordinator-only)
4. Integrate pool into queue — `notifyIdle` releases to pool instead of blocking
5. Add idle timeout (5 min for coordinators) and LRU reclaim policy
6. Emit `work_state` events for pool transitions
7. Test: verify coordinator reuses across sequential messages, verify no racing, verify delegations still exit immediately

### Phase B.1: Warm Specialist Containers (2-3 days)

Extends the pool to specialists. Requires per-container IPC namespaces.

1. **Per-container IPC mount** — change mount from `/workspace/ipc/{group_folder}/input/` to `/workspace/ipc/{group_folder}/{container_id}/input/` on the host side. Inside the container, the path stays `/workspace/ipc/input/` — the agent-runner doesn't change, only what host directory gets mounted.
2. **Pool manager becomes multi-agent** — `acquire(groupFolder, agentId)` instead of `acquire(groupFolder)`. Each agent in a group can have its own warm container.
3. **Delegation lifecycle change** — today `isDelegation: true` makes the agent-runner exit after one response. For pool-managed specialists, the pool controls lifecycle instead: after responding, the specialist returns to the pool rather than exiting. The `isDelegation` flag becomes `poolManaged: true` (container returns to pool on completion) vs `oneShot: true` (legacy exit-immediately behavior for non-pooled delegations).
4. **Per-role idle timeouts** — specialists get shorter idle timeouts (1-2 min) since they're called less frequently. Coordinators keep 5 min. Configurable in `group-config.json`:
   ```json
   {
     "containerPool": {
       "coordinatorIdleMs": 300000,
       "specialistIdleMs": 120000
     }
   }
   ```
5. **Demand-based warmth** — don't pre-warm all specialists. Warm a specialist on first use, keep it warm if it gets reused within the idle window, reclaim if not. A specialist called once in a conversation warms briefly and reclaims — no wasted RAM. A specialist called repeatedly stays warm.
6. **Concurrency budget update** — warm specialists count against `MAX_WARM_CONTAINERS` alongside coordinators. LRU eviction reclaims the least-recently-used container regardless of role when the budget is full.
7. Test: verify analyst stays warm across repeated delegations in one conversation, verify idle specialists reclaim after timeout, verify IPC isolation (no cross-container message leakage)

### Phase C: Automation Rules Phase 2 (2-3 days)

Deterministic routing for cases the trigger-based router can't handle.

1. Extend `evaluateAutomationRules` to return executable actions
2. Add rule execution in `processGroupMessages` — runs after trigger check, before coordinator fallback
3. Add silent delegation support (skip system message)
4. Add safety controls: chain depth limit, cooldown, target validation
5. Add `automation` trace events to `work_state` SSE stream
6. Test: verify rules intercept coordinator-bound messages, post-result chaining works, existing @-mention routing unaffected

### Phase D: Multi-Provider Runtime (3-5 days)

With warm containers and deterministic routing in place, multi-provider becomes the cost multiplier.

1. Define `AgentRuntime` + `RuntimeEvent` interfaces
2. Extract `ClaudeAgentRuntime` from current agent-runner code
3. Add `OllamaRuntime` — simplest second provider (local, no auth complexity)
4. Add `runtime` field to `agent.json`, pass through `ContainerInput`
5. Agent-runner selects runtime based on config, adapts feature set to capabilities
6. Extend credential proxy for multi-provider forwarding
7. Test with a mixed team: Ollama classifier + Claude specialist

### Phase E: Private Agent Workspaces (2-3 days)

With warm containers, this becomes practical. Separate feature but benefits from the pool.

1. Add workspace JID scheme: `web:workspace:{group}:{agent}`
2. Separate message history and session from team thread
3. Route workspace messages to pool (reuse warm container if available)
4. UI: click agent → open private workspace with agent metadata header

---

## Cost Projections

Based on current test-team usage ($27/week, 172 runs, ~$0.16/run):

| Optimization | Mechanism | Estimated Savings |
|---|---|---|
| Warm containers | Cache hits instead of cache writes | 30-50% per run cost |
| Deterministic routing | Skip coordinator for natural-language routing, post-result chains, task follow-ups | 20-30% fewer coordinator runs |
| Multi-provider | Ollama for triage, Sonnet for specialists | 50-70% per run for non-Opus agents |
| Combined | All three layers | 60-80% total cost reduction |

Conservative estimate: $27/week → $6-10/week for equivalent usage.

---

## Risks

### 1. Process ownership complexity

The warm pool requires the host to retain and coordinate long-lived child processes. Today the host's relationship with containers is simple: spawn, parse stdout, wait for exit. Pooling means the host must track process state across multiple queries, handle unexpected container death mid-pool, and manage stdout parser continuity. This is a meaningful increase in `container-runner.ts` complexity (~200-300 lines of new process management code).

Mitigation: keep the one-shot `runContainerAgent` path for delegations and tasks. Only coordinators use the pool path. Two code paths, but the simple one stays simple.

### 2. Warm container memory pressure

Idle containers consume RAM. Docker defaults may limit this.

Mitigation: conservative pool size (3-5 warm), aggressive idle timeout (5 min default for coordinators), monitor via `docker stats`.

### 3. Session state corruption

If a warm container is assigned to a new query while its previous session write is incomplete, state could corrupt.

Mitigation: session write is synchronous in agent-runner (after `runQuery` returns). Pool `acquire` waits for idle state (not busy). The queue serializes per-group, so no parallel assignment.

### 4. IPC namespace collision (multi-container warmth)

Resolved by per-container IPC namespaces in Phase B.1. Host mounts `/workspace/ipc/{group_folder}/{container_id}/input/` → container sees `/workspace/ipc/input/`. Agent-runner code unchanged. Risk: if mount paths are misconfigured, messages route to the wrong container. Mitigation: pool manager validates mount ownership before writing.

### 5. Provider API instability

Ollama and OpenAI endpoints have different failure modes than the Claude SDK. A provider outage could cascade.

Mitigation: per-agent runtime config means failures are isolated to agents on that provider. The orchestrator can detect runtime errors and suppress delegation to failing providers.

### 6. Complexity budget

Five phases of changes to core orchestration code. Each phase must be independently stable.

Mitigation: each phase ships with work-state observability. Phase A (telemetry) comes first so we can see everything. Each subsequent phase is tested against the telemetry baseline before proceeding.

---

## Open Questions

1. **Coordinator-only warmth first?** Yes — Phase B ships coordinator warmth, Phase B.1 follows immediately with specialist warmth via per-container IPC namespaces.

2. **Should Layer 2 rules run before or after trigger matching?** Plan says after (triggers take priority). But some rules might want to override trigger routing — e.g., suppress a specialist and route to the coordinator instead. Worth revisiting when we have real rule usage data from Phase 1 logs.

3. **For Layer 3, is the runtime abstraction boundary session+events or something else?** The plan proposes `RuntimeSession` + `RuntimeEvent` stream. This is richer than a simple query function but thinner than the full Claude SDK surface. Validate this boundary by attempting the `OllamaRuntime` implementation — if it fits cleanly, the interface is right. If it needs hacks, adjust.

---

## Success Criteria

- Test-team weekly cost drops below $10 with equivalent usage
- No increase in error rate or message loss
- Work-state SSE provides accurate, gap-free lifecycle visibility
- Warm container cache hit rate > 60% for sequential coordinator conversations
- Coordinator LLM turns avoided for post-result chaining and task follow-ups where rules fire
- At least one non-Claude provider running in production (Ollama)
