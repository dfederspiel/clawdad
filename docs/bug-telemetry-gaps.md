# Bug Report: Container Telemetry & Observability Gaps

**Filed:** 2026-04-04
**Severity:** Medium — causes confusion when containers are running but UI shows no activity
**Observed in:** Ember Migration multi-agent group (but affects all groups)

## Problem

The web UI loses all indication of running containers on page refresh or service restart. Users see a silent chat with no "Thinking..." indicator even when agents are actively working. The root cause is that all working-state signals are ephemeral (in-memory SSE-driven) with no recovery mechanism.

## Reproduction

1. Send a message to a multi-agent group that triggers a long-running delegation
2. While agents are working (green dots visible, typing indicator showing), refresh the page
3. All working indicators disappear — no typing dot, no agent activity, no progress
4. The agents are still running (check `docker ps`) but the UI is blind to them

Also reproducible via service restart (`launchctl kickstart`): containers survive restart but the new service instance has no knowledge of them.

## Root Causes

### 1. Ephemeral signals lost on refresh

All working-state signals reset to `{}` on page load:

| Signal | Purpose | Persisted? |
|--------|---------|-----------|
| `typingGroups` | Green pulsing dot per group | No |
| `activeAgents` | Per-agent activity dots | No |
| `agentProgress` | Tool activity in typing indicator | No |
| `workState` | Container lifecycle phase | No |
| `typingStartTime` | Elapsed time counter | No |
| `typingAgentName` | Which agent is typing | No |

These are only populated by SSE events (`typing`, `agent_progress`, `work_state`). On refresh, the UI must wait for the next SSE event to fire — which may never come if the container is idle-waiting or between tool calls.

**File:** `web/js/app.js` lines 16-45 (signal definitions)

### 2. Status API doesn't reflect Docker reality

`/api/status` returns queue state only — it does not query Docker. After a service restart:
- Queue state is empty (fresh process)
- Docker has running containers from the previous instance
- Status API reports 0 active groups
- `pollStatus()` sees no active containers → clears any stale `typingGroups`

**File:** `src/channels/web.ts` line 1108 (status endpoint)
**File:** `web/js/app.js` lines 466-489 (`pollStatus` clears typing for stopped containers)

### 3. Orphaned containers are invisible

On shutdown, containers are **detached, not killed** (intentional — prevents interrupting active work). But the new service instance has no mechanism to:
- Discover these containers via Docker
- Reconnect to their stdout for output parsing
- Report them in the status API

The `cleanupOrphans()` function at startup **kills** orphaned containers rather than reconnecting. This means active work is lost on restart.

**File:** `src/group-queue.ts` lines 624-644 (shutdown detaches containers)
**File:** `src/index.ts` lines 1816-1820 (`cleanupOrphans` called at startup)

### 4. No SSE replay on reconnect

When the browser's EventSource auto-reconnects after a network blip, there's no mechanism to replay missed events. If a `typing` start event was sent during the disconnect, the UI never shows the indicator.

**File:** `web/js/api.js` lines 20-31 (`connectSSE` — no replay logic)

### 5. Work state not persisted

`WorkStateEvent` is broadcast via SSE but never written to the database. There's no `work_state` table to query on refresh. The 14 lifecycle phases (`queued`, `thinking`, `working`, `delegating`, `pool_acquired`, etc.) exist only in the moment.

**File:** `src/types.ts` lines 81-111 (WorkStateEvent definition)

## Proposed Fixes (Priority Order)

### P1: Hydrate working state on page load

Add a `/api/work-state` endpoint that returns the current `workState` for all groups (or the selected group). On page load, after `loadGroups()`, fetch this and set `typingGroups`, `activeAgents`, and `workState` signals.

**Server side:** The queue already has `getSnapshot()` which includes `active`, `idleWaiting`, `agentName`, `activeDelegations` per group. Extend it or create a new endpoint that also includes the last `WorkStateEvent` per jid.

**Client side:** In `app.js`, after `loadGroups()`:
```javascript
const ws = await api.getWorkState();
for (const entry of ws.groups) {
  if (entry.active && !entry.isTask) {
    typingGroups.value = { ...typingGroups.value, [entry.jid]: true };
    if (entry.agentName) {
      typingAgentName.value = { ...typingAgentName.value, [entry.jid]: entry.agentName };
      typingStartTime.value = { ...typingStartTime.value, [entry.jid]: Date.now() };
    }
  }
}
```

### P2: Detect orphaned containers in status

Extend `/api/status` to check Docker for containers matching the `nanoclaw-` prefix that aren't tracked by the queue. Report them as `orphaned` containers with their name, group, uptime, and running state.

```typescript
// In status handler:
const dockerContainers = execSync('docker ps --filter name=nanoclaw- --format "{{.Names}} {{.RunningFor}}"');
const tracked = new Set(queue groups containerNames);
const orphaned = dockerContainers.filter(c => !tracked.has(c.name));
```

### P3: Persist last WorkStateEvent per group

Add a `work_state` column to the groups table (or a separate table) storing the last WorkStateEvent JSON. Update it on each `emitWorkState()`. Query it on page load for P1.

### P4: SSE catch-up on reconnect

On SSE reconnect, have the client immediately poll `/api/work-state` (from P1) to catch up on any missed events. This covers both network blips and full page refreshes.

### P5: Container lifecycle in status

Extend the status snapshot to include per-container metadata:
- Container spawn timestamp (for uptime display)
- Query count (how many messages this container has handled)
- Cold start vs warm reuse
- Pool idle duration

## Affected Files

| File | Role |
|------|------|
| `src/channels/web.ts` | Status endpoint, new work-state endpoint |
| `src/group-queue.ts` | Expose richer snapshot with WorkStateEvent |
| `src/index.ts` | Startup recovery, orphan detection |
| `src/container-pool.ts` | Pool snapshot with container metadata |
| `web/js/app.js` | State hydration on load, SSE reconnect handler |
| `web/js/api.js` | New `getWorkState()` API call, SSE reconnect logic |
| `web/js/components/TypingIndicator.js` | Show recovered state (elapsed time approximation) |
| `web/js/components/GroupItem.js` | Show orphaned/recovered container indicators |

## Notes

- P1 alone would fix the most visible symptom (no indicators after refresh)
- P2 is important for service restarts during active work
- P3+P4 together give full resilience across all scenarios
- P5 is nice-to-have for power users / debugging
