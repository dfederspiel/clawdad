# Bug: Coordinator Re-trigger Loop Causes Redundant Agent Spawns

**Severity:** Medium — wastes tokens/cost, confuses users with duplicate messages
**Observed in:** `web_web_ember-migration` group (5-agent team), April 7 2026
**Status:** Open

## Observed Behavior

User sends a single message ("roll call"). The expected flow is:

1. Coordinator sees the message, delegates to 4 specialists
2. Specialists respond in parallel
3. Coordinator is re-triggered, sees specialist output, synthesizes a summary
4. Done

What actually happens:

1. Coordinator sees the message, delegates to 4 specialists (correct)
2. Specialists respond in parallel (correct)
3. Coordinator is re-triggered and synthesizes (correct)
4. **Specialists are re-triggered again** — each responds a second or third time
5. **Coordinator is re-triggered again** — sees new specialist output, re-synthesizes
6. Loop continues for 2-3 cycles before eventually settling

### Evidence from message log

For a single "roll call" user message, the group produced **24 messages** (should be ~7):

| Agent | Messages | Expected |
|-------|----------|----------|
| System (delegation confirmations) | 15 | 5 |
| Migration Lead (coordinator) | 3 | 2 |
| API Validator | 2 | 1 |
| Builder | 1 | 1 |
| Analyzer | 1 | 1 |
| Validator | 1 | 1 |

The 15 system messages are `[X has responded above.]` markers — each delegation completion emits one. Three coordinator turns means the coordinator was triggered 3 times instead of once.

### Timeline showing the loop

```
04:09:42  User: "roll call"
04:10:06  Builder responds                    ← Round 1 (correct)
04:10:07  System: [Builder has responded]
04:10:09  API Validator responds
04:10:09  Analyzer responds
04:10:09  Coordinator: "squad is checking in" ← Coordinator sees partial results
04:10:09  System: [Analyzer responded]
04:10:10  System: [API Validator responded]
04:10:15  Validator responds
04:10:16  System: [Validator responded]
04:10:16  System: [API Validator responded]   ← DUPLICATE re-trigger
04:10:17  System: [Builder responded]         ← DUPLICATE re-trigger
04:10:18  System: [Analyzer responded]        ← DUPLICATE re-trigger
04:10:23  System: [Validator responded]       ← DUPLICATE re-trigger
04:10:29  System: [Builder responded]         ← THIRD re-trigger
04:10:31  System: [Analyzer responded]        ← THIRD re-trigger
04:10:54  API Validator: "Already introduced" ← Agent knows it already ran
04:10:59  Coordinator: "Waiting on..."        ← Coordinator has stale context
04:11:13+ More system messages                ← Loop continues
04:11:29  Coordinator: final summary          ← Eventually settles
```

## Root Cause Analysis

The bug is a feedback loop between delegation completion and the coordinator re-trigger mechanism. Two interacting issues:

### Issue 1: Each delegation completion can independently trigger a re-check

When specialists run in parallel, they complete at slightly different times. The completion logic in `group-queue.ts:412-428` checks:

```typescript
if (state.activeDelegations === 0 && state.pendingDelegations.length === 0) {
  // All delegations complete — re-trigger coordinator
  this.enqueueMessageCheck(groupJid);
}
```

This fires once when the last delegation completes. But the coordinator's response is itself stored as a bot message, and if it delegates again (or the coordinator's output triggers a new `processGroupMessages` cycle), the loop restarts.

### Issue 2: Coordinator re-trigger sees its own delegation instructions as new messages

When re-triggered via `enqueueMessageCheck`, `processGroupMessages` (`index.ts:875-882`) fetches messages since the cursor:

```typescript
const missedMessages = getMessagesSince(
  chatJid,
  getOrRecoverCursor(chatJid),  // cursor from BEFORE specialists spawned
  ASSISTANT_NAME,
  MAX_MESSAGES_PER_PROMPT,
  isMultiAgent,  // true → includeBotMessages
);
```

The cursor was advanced at `index.ts:1044-1045` to the last **user** message before specialists were spawned. When the coordinator is re-triggered:

- `includeBotMessages = true` (because `isMultiAgent`)
- It fetches: specialist responses + coordinator's own previous output
- The coordinator sees all the specialist output and responds again
- That response triggers another delegation cycle

### Issue 3: No deduplication of specialist re-invocations

The triggered-agents logic at `index.ts:1050-1054` checks message content against agent triggers:

```typescript
const triggeredAgents = agents.filter((agent) => {
  if (!agent.trigger) return true; // coordinator always matches
  const agentTrigger = buildAgentTriggerPattern(agent.trigger);
  return missedMessages.some((m) => agentTrigger.test(m.content.trim()));
});
```

When the coordinator responds with text like "you'll hear from @analyzer, @api-validator, @builder, and @validator", that message **contains specialist triggers**. On re-trigger, these mentions cause the specialists to be re-enqueued.

## Why It Eventually Settles

The loop dampens because:
1. Specialists start responding with "Already introduced myself" (no new triggers)
2. The coordinator eventually produces output that doesn't mention specialist triggers
3. The message window fills enough that new fetches return no genuinely new content

## Proposed Fix Directions

### Option A: Cursor advancement after coordinator synthesizes

After the coordinator runs on re-trigger, advance the cursor past all specialist + coordinator output. This prevents the next `processGroupMessages` from seeing already-processed messages.

**Risk:** If the coordinator's synthesis fails, we lose the specialist output window.

### Option B: Skip specialist fan-out on coordinator re-trigger

Track whether the current `processGroupMessages` call originated from a delegation completion re-trigger. If so, only run the coordinator — don't re-scan for specialist @-mentions in the message batch.

**Implementation:** Add a `isRetrigger` flag to `enqueueMessageCheck` that propagates through to `processGroupMessages`.

### Option C: Exclude coordinator's own messages from trigger matching

When building `missedMessages` for trigger detection, filter out messages where `sender_name` matches any agent in the group. Only user messages should trigger specialist fan-out.

**Implementation:** Filter at `index.ts:1050-1054`:
```typescript
const userMessages = missedMessages.filter(m => !groupAgentList.some(a => a.displayName === m.sender_name));
const triggeredAgents = agents.filter((agent) => {
  if (!agent.trigger) return true;
  const agentTrigger = buildAgentTriggerPattern(agent.trigger);
  return userMessages.some((m) => agentTrigger.test(m.content.trim()));
});
```

### Option D: Delegation deduplication window

In `enqueueDelegation`, reject enqueues for agents that completed a delegation within the last N seconds for the same group. This is a safety net rather than a root cause fix.

### Recommended Approach

**Option C** is the most surgical fix — coordinator output containing @-mentions should never trigger specialist fan-out. Combine with **Option B** as a belt-and-suspenders guard: re-trigger runs should only spawn the coordinator, never specialists.

## Reproduction

1. Create a multi-agent group with 3+ specialists
2. Send a message that triggers all specialists (e.g., no @-mention, so coordinator delegates to all)
3. Watch the message log — you'll see 2-3x the expected messages
4. Check logs for repeated `All delegations complete, re-triggering coordinator` entries

## Related Code

| File | Lines | Role |
|------|-------|------|
| `src/group-queue.ts` | 314-361 | `enqueueDelegation` — queues specialist work |
| `src/group-queue.ts` | 363-444 | `runDelegation` — executes and handles completion |
| `src/group-queue.ts` | 412-428 | Delegation completion → coordinator re-trigger |
| `src/index.ts` | 875-882 | Message fetch with `includeBotMessages` |
| `src/index.ts` | 1044-1045 | Cursor advancement before specialist spawn |
| `src/index.ts` | 1050-1054 | Agent trigger matching on message content |
| `src/index.ts` | 1082-1236 | Multi-specialist parallel fan-out |
