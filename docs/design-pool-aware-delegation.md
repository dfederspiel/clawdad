# Design: Pool-Aware Delegation (Phase B.1)

**Status:** Draft
**Date:** 2026-04-03
**Depends on:** Warm Container Pool (Phase B, shipped)

## Problem

Delegations always cold-start. When the coordinator delegates to `@analyst`, a new container spawns, loads a fresh SDK session, writes 6M+ cache tokens, responds, and exits. If the analyst is called again 30 seconds later, the whole cycle repeats.

The warm pool exists but explicitly excludes delegations:

```typescript
// src/index.ts:1126
if (isCoordinator && !isDelegation) {
  const warmHandle = pool.acquire(agentId);
```

This made sense for Phase B — one IPC reader per group, no namespace ambiguity. But specialists are the most repeated delegation targets, and warming them would cut cache writes dramatically.

## Target

```
coordinator delegates to @analyst →
  pool has warm analyst? → route query to it (cache hit) → return to pool
  no warm analyst? → spawn new → query → release to pool for next time
```

Specialists warm on first use and stay warm if reused within an idle window. A specialist called once warms briefly and reclaims. A specialist called repeatedly stays warm.

## Constraint: IPC Namespace Isolation

Today, IPC uses a single per-group directory:

```
data/ipc/{group_folder}/input/     ← one directory, all containers share it
```

The host writes messages here (`group-queue.ts:232`, `index.ts:1140`). The agent-runner polls it (`agent-runner/src/index.ts`). With one warm coordinator per group, there's one reader — no ambiguity.

With multiple warm containers per group (coordinator + N specialists), we need to route messages to the correct container. Two containers polling the same `input/` directory would race.

### Resolution: Per-Container Input Namespace

**Host side:** `data/ipc/{group_folder}/{agent_name}/input/`

**Container side:** `/workspace/ipc/input/` (unchanged — only the mount changes)

The agent-runner code doesn't change. The host decides which subdirectory to mount as `/workspace/ipc` when spawning the container. When writing a follow-up message to a warm specialist, the host writes to that specialist's namespace.

**What stays group-scoped:** `delegations/`, `achievements/`, `credentials/`, `messages/`, `tasks/` — these are consumed by the host IPC watcher, not by specific containers. They remain at `data/ipc/{group_folder}/`.

**What moves to per-container:** Only `input/` (the follow-up message delivery path). This is the only directory where a warm container polls for new work.

### Provenance on Shared IPC Channels

Per-container `input/` solves the wake-up routing problem, but delegation artifacts still flow through shared group-scoped directories. Today, `ipc-mcp-stdio.ts` emits delegation requests into `ipc/{group}/delegations/` with `sourceAgent` and `targetAgent`, and `ipc.ts` consumes them from the same shared directory. With multiple warm containers active in one group, tracing which container produced which artifact becomes ambiguous.

**Invariant:** Every IPC artifact emitted by a pooled container must carry `agentId`, `containerId`, and `sessionId` in its JSON payload. This doesn't change the directory structure (the host watcher still reads from the shared group dir), but it makes every artifact self-describing for logging, debugging, and future trace correlation.

**Concrete changes:**
- `ipc-mcp-stdio.ts` `delegate_to_agent` tool: add `containerId` (from `NANOCLAW_CONTAINER_NAME` env var) and `sessionId` (from `NANOCLAW_SESSION_ID` env var) to the delegation JSON alongside the existing `sourceAgent`/`targetAgent`.
- `ipc-mcp-stdio.ts` `send_message` tool: same — include `agentId`, `containerId`, `sessionId`.
- `ipc.ts` delegation consumer: log the full provenance tuple on processing. No structural change to consumption — it's still group-scoped — but the log entries become traceable.
- `src/index.ts` container env: pass `NANOCLAW_CONTAINER_NAME` and `NANOCLAW_SESSION_ID` to the container so the agent-runner can include them in IPC artifacts.

This is not a blocking dependency for the pool-aware delegation work, but it should ship in the same PR or immediately after. Without it, pooled specialists are operationally correct but opaque when debugging concurrent warm agents in a single group.

## Implementation Steps

### Step 1: Per-Container IPC Mount

**Files:** `src/container-runner.ts`, `src/group-folder.ts`

Today (`container-runner.ts:213-223`):
```typescript
const groupIpcDir = resolveGroupIpcPath(group.folder);
fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
mounts.push({
  hostPath: groupIpcDir,
  containerPath: '/workspace/ipc',
  readonly: false,
});
```

After:
```typescript
const groupIpcDir = resolveGroupIpcPath(group.folder);
// Shared IPC subdirs (host-consumed) — mounted readonly
mounts.push({
  hostPath: groupIpcDir,
  containerPath: '/workspace/ipc',
  readonly: false,
});

// Per-container input namespace — writable, agent-specific
const agentInputDir = path.join(groupIpcDir, agentName, 'input');
fs.mkdirSync(agentInputDir, { recursive: true });
mounts.push({
  hostPath: agentInputDir,
  containerPath: '/workspace/ipc/input',
  readonly: false,
});
```

The per-container `input/` mount overlays the group-level mount at `/workspace/ipc/input`. Docker bind mounts are last-wins, so the agent-runner sees only its own input directory. The rest of `/workspace/ipc/` (delegations, credentials, etc.) remains the shared group directory.

**New helper in `group-folder.ts`:**
```typescript
export function resolveAgentIpcInputPath(folder: string, agentName: string): string {
  assertValidGroupFolder(folder);

  // Defensive sanitization: agentName becomes a filesystem routing primitive here.
  // Even though agent-discovery validates names upstream, this helper is a trust
  // boundary — it must not rely on callers having validated first.
  if (!agentName || typeof agentName !== 'string') {
    throw new Error('agentName is required');
  }
  const sanitized = agentName.replace(/[^a-zA-Z0-9_-]/g, '');
  if (sanitized !== agentName || sanitized.length === 0) {
    throw new Error(`Unsafe agent name for IPC path: ${JSON.stringify(agentName)}`);
  }

  const groupIpcBase = path.resolve(DATA_DIR, 'ipc', folder);
  const inputPath = path.resolve(groupIpcBase, sanitized, 'input');

  // Belt-and-suspenders: verify resolved path is under the group's IPC base
  if (!inputPath.startsWith(groupIpcBase + path.sep)) {
    throw new Error(`Agent IPC path escapes group boundary: ${inputPath}`);
  }
  return inputPath;
}
```

The strict sanitization matters because this path is used for both mount targets and file writes — it's a filesystem routing primitive, not just a label. Rejecting (not silently stripping) invalid characters ensures mismatches surface loudly rather than creating ghost directories.

### Step 2: Update Host Write Paths

Every place the host writes to `input/` must target the agent-specific namespace.

**`index.ts` warm reuse path (line 1140):**
```typescript
// Before:
const inputDir = path.join(DATA_DIR, 'ipc', group.folder, 'input');

// After:
const agentName = agent?.name || DEFAULT_AGENT_NAME;
const inputDir = resolveAgentIpcInputPath(group.folder, agentName);
```

**`group-queue.ts` sendMessage (line 232):**

`sendMessage` currently writes to `data/ipc/{groupFolder}/input/`. It needs the agent name to target the right namespace. Add `agentName` to `GroupState`:

```typescript
interface GroupState {
  // ... existing fields ...
  agentName: string | null;  // NEW: which agent owns the active container
}
```

Set it in `registerProcess` and use it in `sendMessage`:
```typescript
sendMessage(groupJid: string, text: string): boolean {
  const state = this.getGroup(groupJid);
  if (!state.active || !state.groupFolder || state.isTaskContainer) return false;
  const agentName = state.agentName || 'default';
  const inputDir = resolveAgentIpcInputPath(state.groupFolder, agentName);
  // ... rest unchanged ...
}
```

**`container-pool.ts` writeCloseSentinel:**
The pool writes `_close` to shut down idle containers. It needs the agent name:

```typescript
// Before:
private writeCloseSentinel(groupFolder: string): void {
  const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');

// After:
private writeCloseSentinel(groupFolder: string, agentName: string): void {
  const inputDir = resolveAgentIpcInputPath(groupFolder, agentName);
```

Update `PoolEntry` to carry `agentName` (it already has `agentId` which includes the agent name, but we need the raw name for the path).

### Step 3: Remove the Delegation Guard from Pool Acquire

**`index.ts:1126`:**
```typescript
// Before:
if (isCoordinator && !isDelegation) {

// After:
if (!isDelegation || WARM_POOL_ENABLED) {
```

Wait — this is too broad. The warm reuse path and the cold-start-to-pool path both need updating. Let's be precise:

**Warm reuse path** — try pool for any agent (coordinator or specialist):
```typescript
// ── Warm reuse path ────────────────────────────────────────────
const warmHandle = pool.acquire(agentId);
if (warmHandle) {
  // ... write IPC message to agent-specific input dir ...
  // ... queryOnce, release on success, reclaim on error ...
}
```

**Cold start → pool release** — spawn with pool lifecycle for any poolable agent:
```typescript
// ── Cold start with pool release ───────────────────────────────
if (WARM_POOL_ENABLED) {
  const handle = await spawnContainer(group, containerInput);
  // ... queryOnce ...
  if (result.status !== 'error') {
    pool.release(agentId, handle, chatJid);
  }
  // ...
}
```

**One-shot fallback** — pool disabled, use existing `runContainerAgent`:
```typescript
// ── One-shot path (pool disabled) ──────────────────────────────
const output = await runContainerAgent(group, containerInput, ...);
```

The `isDelegation` flag in `ContainerInput` still matters for the agent-runner: it controls whether the agent-runner enters `waitForIpcMessage` after the first response. With pool-aware delegation, warm specialists DO wait for IPC — they're no longer one-shot.

### Step 4: Agent-Runner Lifecycle Change

**`container/agent-runner/src/index.ts`:**

Today, `isDelegation: true` skips the IPC idle loop — the container exits after one response. For warm specialists, we need the container to stay alive and wait for follow-up queries.

Add `poolManaged` alongside `isDelegation` (do not replace it):
```typescript
// ContainerInput (both host and agent-runner):
isDelegation: boolean;  // KEPT — delegation semantics (output routing, session reuse, completion signaling)
poolManaged: boolean;   // NEW  — container lifetime (stay alive for follow-up queries vs exit after one)
```

**Key invariant: pooling changes container lifetime, not delegation semantics.**

A pooled specialist is still a delegation. It still:
- Routes output through the delegation completion path (not the coordinator's message-loop piping path)
- Signals completion to the queue so the coordinator re-triggers
- Does NOT inherit coordinator-style idle behavior (no `notifyIdle` to the queue, no message-loop piping)
- Does NOT persist its session in the coordinator's session slot
- Does NOT become the "active agent" for message routing purposes

The only thing `poolManaged` changes is whether the agent-runner enters `waitForIpcMessage` after responding. When `poolManaged: true`, the container stays alive and the host can send another query via the per-container `input/` namespace. When false, the container exits after one response (current behavior).

**The matrix:**

| isDelegation | poolManaged | Behavior |
|---|---|---|
| false | true | Coordinator (current warm pool path) |
| false | false | Coordinator, pool disabled (legacy one-shot) |
| true | true | **NEW: pooled specialist** — delegation semantics, warm lifetime |
| true | false | Current delegation — fire and exit |

**What `isDelegation` still controls (unchanged):**
- Agent-runner skips `waitForIpcMessage` idle loop when `poolManaged` is false (today's exit-on-complete)
- Host-side output routing: delegation results go through `onDelegateComplete`, not `processGroupMessages`
- Queue accounting: delegation containers count via `activeDelegations`, not `active`
- Session handling: delegation sessions are transient by default (see Open Question #3)

**What `poolManaged` controls (new):**
- Agent-runner enters `waitForIpcMessage` after first response (container stays alive)
- Host writes `_close` sentinel to reclaim instead of relying on process exit
- Container is released to pool on success instead of being abandoned

**Backward compatibility:** When `poolManaged` is absent or false, behavior is identical to today. The agent-runner checks `poolManaged` only for the "should I wait for more input?" decision. All other delegation-specific logic continues to key off `isDelegation`.

### Step 5: Per-Role Idle Timeouts

**`src/container-pool.ts`:**

Add per-role timeout support to `release()`:

```typescript
release(agentId: string, handle: ContainerHandle, groupJid: string, idleTimeoutMs?: number): void {
  // ... existing logic ...
  const timeout = idleTimeoutMs ?? this.idleTimeoutMs;
  entry.idleTimer = setTimeout(() => {
    this.reclaim(agentId);
  }, timeout);
}
```

**Defaults:**
- Coordinators: 5 minutes (high traffic, rich context)
- Specialists: 90 seconds (demand-based, shorter warmth window)

Configurable per-group via `group-config.json`:
```json
{
  "poolConfig": {
    "coordinatorIdleMs": 300000,
    "specialistIdleMs": 90000
  }
}
```

### Step 6: Queue Integration for Delegations

**`src/group-queue.ts` `enqueueDelegation`:**

Today, delegations bypass per-group serialization and run in parallel. This doesn't change — warm specialists still run concurrently.

The queue needs to register the agent name when a delegation starts, so `sendMessage` and `closeStdin` target the right IPC namespace. Add `agentName` to delegation tracking.

**`runDelegation` changes:**
```typescript
private async runDelegation(groupJid: string, task: QueuedTask): Promise<void> {
  const state = this.getGroup(groupJid);
  state.activeDelegations++;
  this.activeWorkCount++;
  // ... existing logging ...

  try {
    await task.fn();
  } finally {
    state.activeDelegations--;
    this.activeWorkCount--;
    // Pool release happens inside the task fn (in index.ts),
    // not here. The queue doesn't own pool lifecycle.
    // ... existing completion logic (re-trigger coordinator) ...
  }
}
```

No structural change needed here — the pool acquire/release happens inside the delegation's `fn()` callback (in `runContainerForGroup`), not in the queue.

## Delegation Flow: Before and After

### Before (current)

```
1. Coordinator calls delegate_to_agent("analyst", "check the data")
2. Host receives IPC delegation request
3. queue.enqueueDelegation(groupJid, taskId, fn)
4. fn() → runContainerForGroup(group, prompt, chatJid, ..., agent, isDelegation=true)
5. spawnContainer() → cold start, full cache write
6. Agent responds → container exits (isDelegation skips idle loop)
7. All delegations done → re-trigger coordinator
```

### After (pool-aware)

```
1. Coordinator calls delegate_to_agent("analyst", "check the data")
2. Host receives IPC delegation request
3. queue.enqueueDelegation(groupJid, taskId, fn)
4. fn() → runContainerForGroup(group, prompt, chatJid, ..., agent, isDelegation=true)
5. pool.acquire(agentId) → warm analyst found?
   YES → write IPC message to analyst's input dir → queryOnce → release back
   NO  → spawnContainer(poolManaged=true) → queryOnce → release to pool
6. Analyst stays warm in pool (90s idle timeout)
7. All delegations done → re-trigger coordinator
8. Next delegation to analyst → step 5 hits warm path (cache hit)
```

## Risk Assessment

### IPC Mount Overlay

The overlay mount (`/workspace/ipc/input` over `/workspace/ipc`) is standard Docker behavior but adds cognitive complexity. If the overlay mount fails or is ordered wrong, the container reads the shared group `input/` — potential message cross-contamination.

**Mitigation:** Validate mount ordering in `buildVolumeMounts` (agent-specific last). Add a startup assertion in agent-runner that verifies `/workspace/ipc/input/.agent-name` marker file.

### Stale Warm Specialists

A specialist warm in the pool holds a session. If the group's `CLAUDE.md` or agent config changes while the specialist is idle, it'll respond with stale context.

**Mitigation:** On config change (detected by existing file watcher), reclaim all warm containers for that group. The pool already supports `reclaim(agentId)`.

### Pool Size Pressure

Multi-agent groups with 3-4 specialists could hold 4-5 warm containers per group. With 3 active groups, that's 12-15 warm containers competing for the idle budget.

**Mitigation:** Short specialist timeouts (90s). `evictOldest()` already handles pressure. Consider per-group warm limits (e.g., max 2 warm specialists per group).

### Delegation Concurrency

Multiple specialists can run concurrently (fan-out). If analyst and reviewer both warm after responding, the pool now holds 3 containers for one group (coordinator + 2 specialists). This is fine for the idle budget but increases memory pressure.

**Mitigation:** Specialists only pool if `WARM_POOL_ENABLED`. Idle timeout is the pressure relief valve. Monitor via existing telemetry.

## Testing Plan

1. **Unit: per-container IPC path resolution** — `group-folder.test.ts`, verify agent-scoped paths resolve correctly and reject traversal
2. **Unit: pool acquire/release for specialists** — `container-pool.test.ts`, verify specialist entries work identically to coordinator entries
3. **Unit: per-role idle timeouts** — verify specialist entries timeout at configured interval
4. **Integration: warm specialist reuse** — delegate to analyst twice in quick succession, verify second call hits `warm_reuse` (check `container_reuse` in agent_runs table)
5. **Integration: IPC isolation** — two specialists warm simultaneously, verify messages route to correct container (no cross-contamination)
6. **Integration: idle eviction** — warm specialist expires after timeout, next delegation cold-starts
7. **Regression: coordinator warmth unchanged** — existing coordinator pool tests still pass
8. **Regression: one-shot fallback** — with `WARM_POOL_ENABLED=false`, delegations behave exactly as before
9. **Unit: path helper sanitization** — `group-folder.test.ts`, verify `resolveAgentIpcInputPath` rejects traversal (`../`), special chars, empty strings, and non-alphanumeric agent names
10. **Integration: IPC artifact provenance** — verify delegation JSON files in `ipc/{group}/delegations/` carry `agentId`, `containerId`, `sessionId`; verify log entries include the full provenance tuple

## Implementation Punch-List

### 1. IPC Path Helpers

- Add `resolveAgentIpcInputPath(folder, agentName)` for per-container input paths.
- Add `resolveGroupSharedIpcPath(folder)` (or rename existing `resolveGroupIpcPath`) to make the shared-vs-owned distinction explicit in call sites.
- Validate path components at the helper boundary — strict sanitization, reject don't strip, even if discovery already validated.

### 2. Container Runner Mounts

- Update `buildVolumeMounts` so `/workspace/ipc/input` is container-owned (per group + agent).
- Group-level `/workspace/ipc` mount comes first, per-container `input/` overlay comes last.
- Verify shared directories (`delegations/`, `messages/`, `tasks/`, `achievements/`, `credentials/`) remain visible and unchanged inside the container.
- Write `.agent-name` marker into the per-container input dir at mount time for startup assertion.

### 3. Pool Write Path

- Change pooled specialist wake-ups to write only to the new per-container `input/` path.
- Keep coordinator behavior unchanged until specialist pooling is enabled.
- Update `container-pool.ts` `writeCloseSentinel` to target the agent-specific input dir.

### 4. Lifecycle Flag Cleanup

- Add `poolManaged` flag to `ContainerInput`. Replace `isDelegation` checks with `poolManaged` **only** where container lifetime is the real concern (agent-runner idle loop decision).
- Preserve `isDelegation` and one-shot delegation semantics everywhere else: output routing, queue accounting, session handling, completion signaling.
- See the behavior matrix in Step 4 above for the full invariant.

### 5. Provenance Hardening

- Ensure delegation payloads in `ipc-mcp-stdio.ts` include `agentId` (required).
- Include `containerId` (from `NANOCLAW_CONTAINER_NAME`) and `sessionId` (from `NANOCLAW_SESSION_ID`) for debugging — both passed as container env vars.
- Update `ipc.ts` delegation consumer to log the full provenance tuple.

### 6. Queue Integration

- Make queue state reflect pooled specialists without treating them like ordinary active group processes.
- Pooled specialists count against `activeDelegations` while running, then transfer to pool ownership on release. The queue does not track idle pooled containers — the pool does.
- Add `agentName` to `GroupState` so `sendMessage` and `closeStdin` target the right IPC namespace.

### 7. Session Handling

- Verify specialist sessions are keyed by `agentId` (e.g., `web_team/analyst`) and survive warm reuse.
- Confirm `setSession`/`getSession` path works for specialist agentIds — they use the same session store as coordinators.
- Stale-session recovery (`no conversation found` error) must evict only the affected pooled specialist, not all containers for the group.

### 8. Telemetry

- Emit `work_state` events for pooled specialist lifecycle: `pool_acquired` (warm hit), `pool_released` (returned to pool), `pool_reclaimed` (idle timeout or eviction), `pool_cold_start` (no warm container, spawning fresh).
- Log container reuse status (`warm_reuse` vs `cold_start`) in `agent_runs` table for specialists, same as coordinators.
- Make pool snapshot visible in the existing `/api/queue` or pool status endpoint.

### 9. Tests

- Warm specialist receives only its own delegated input (IPC isolation).
- Two warm specialists in one group do not cross-trigger.
- Shared IPC outputs (`delegations/`, `messages/`) still reach host consumers correctly.
- Cold fallback works when no warm specialist exists.
- Stale pooled specialist gets evicted and recovers cleanly (spawn fresh on next delegation).
- Path helper rejects traversal, special chars, empty strings.
- Delegation JSON carries provenance fields.
- Coordinator pool behavior is unchanged (regression).
- `WARM_POOL_ENABLED=false` produces identical behavior to today (regression).

### 10. Rollout

Ship behind the existing `WARM_POOL_ENABLED` flag, with a new `WARM_SPECIALISTS_ENABLED` flag to gate specialist pooling separately:

- `WARM_POOL_ENABLED=true` + `WARM_SPECIALISTS_ENABLED=false` → coordinators warm (current behavior), specialists one-shot.
- `WARM_POOL_ENABLED=true` + `WARM_SPECIALISTS_ENABLED=true` → both warm.
- `WARM_POOL_ENABLED=false` → everything one-shot, no pool.

This lets us ship the IPC namespace changes and lifecycle flag cleanup first, then flip specialist pooling on independently once we're confident the plumbing is solid.

## Open Questions

1. **Should we warm _all_ specialists, or only frequently-called ones?** The plan says "demand-based warmth" — warm on first use, keep warm if reused. But a one-off specialist that warms for 90s and is never called again wastes a pool slot. Consider a minimum-use threshold (e.g., only pool after 2+ calls in 10 minutes).

2. **Fan-out race on pool release.** If coordinator delegates to analyst + reviewer simultaneously, both spawn cold (no warm entry yet). Both finish and release to pool. Next fan-out: both are warm. This is fine, but verify the pool handles concurrent releases to different agentIds without races.

3. **Session ID sync for specialists.** The coordinator path syncs session IDs via `result.newSessionId`. Delegations currently don't persist sessions (they're one-shot). Warm specialists need session persistence — verify the `setSession`/`getSession` path works for specialist agentIds.
