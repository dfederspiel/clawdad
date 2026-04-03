# Plan: Achievements and XP Repair

**Status:** Proposed
**Date:** 2026-04-03

## Why This Needs Attention

The current achievements system has two problems at once:

1. **Some of it is broken or unreliable**
2. **The progression curve feels dead even when it does work**

That combination is especially rough in the UI:

- users unlock a few things early
- XP stops moving in visible ways
- level remains flat
- the system feels abandoned rather than rewarding

The goal of this plan is to make the system:

- **correct** first
- **trustworthy** second
- **motivating** third

## What We Found

### 1. Built-in achievements are mostly not event-driven

Most platform achievements are defined centrally in [src/achievements.ts](/home/david/code/clawdad/src/achievements.ts), but they do not have first-class server-side unlock hooks.

Instead, unlocks mostly happen in two ways:

- agent containers explicitly call `unlock_achievement` through MCP in [container/agent-runner/src/ipc-mcp-stdio.ts](/home/david/code/clawdad/container/agent-runner/src/ipc-mcp-stdio.ts)
- meta achievements are checked inside `GET /api/telemetry` in [src/channels/web.ts](/home/david/code/clawdad/src/channels/web.ts)

That means many platform achievements only unlock if the agent remembers to do it.

This is fragile for core product milestones like:

- first message
- first thread reply
- first triggered agent
- 3 active groups
- 3 scheduled tasks

The app itself already knows when these happen. The unlocks should be deterministic.

### 2. Meta achievements depend on the telemetry endpoint being polled

`centurion`, `streak_7`, and `streak_30` are checked in the `/api/telemetry` request path.

That means achievement progress depends on:

- the web UI being open
- the polling loop running
- the request succeeding

This is the wrong dependency direction. Achievements should come from product events, not dashboard refresh timing.

### 3. Client XP can drift from server truth

The client-side SSE handler in [web/js/achievements.js](/home/david/code/clawdad/web/js/achievements.js) increments XP optimistically when an achievement event arrives.

That is fine for toasts, but risky as the canonical progression model because:

- duplicate or replayed events can double-count in memory
- local state can diverge from persisted state

### 4. The level curve is too flat

The current formula is:

```javascript
level = Math.floor(xp / 500) + 1
```

This is simple, but not good for early progression.

With sparse one-time achievements, users can do a fair amount of real work and still sit at level 1 for too long.

### 5. The system lacks repeatable XP sources

Today, XP is mostly driven by one-time unlocks.

That means once the obvious firsts are done, progression stalls.

This is why the system feels dead after early exploration.

## Principles

### 1. Product events should unlock product achievements

If the server can observe a milestone directly, the server should award it directly.

### 2. Agents can still award experiential achievements

The MCP-based `unlock_achievement` tool still has value for things like:

- "the user saw a dashboard-style output"
- "the agent recalled prior memory"
- "the user completed a teaching interaction"

Those are less deterministic and still benefit from agent judgment.

### 3. UI should reflect canonical state

The server should remain the source of truth for XP, unlocks, and progression.

### 4. Progression needs both milestones and momentum

We should separate:

- **achievements**: memorable one-time unlocks
- **XP flow**: ongoing progress that keeps the system feeling alive

## Recommended Architecture

Introduce a dedicated achievements service layer instead of scattering logic.

Possible new module:

- `src/achievement-service.ts`

Core responsibilities:

- unlock by deterministic product event
- unlock by achievement ID
- evaluate meta achievements
- compute progression state
- broadcast unlocks

## Phase 1: Make the System Correct

### Goal

Fix the trust issues first.

### 1. Add deterministic unlock hooks

Move these out of agent judgment and into explicit application events:

- `first_contact`
  Trigger when the first user message is stored

- `clockwork`
  Trigger when the first scheduled task is created

- `thread_weaver`
  Trigger when the first thread reply is sent

- `specialist`
  Trigger when the first triggered agent is created

- `architect`
  Trigger when the count of active non-system groups reaches 3

- `assembly_line`
  Trigger when the count of scheduled tasks reaches 3

Likely touchpoints:

- [src/channels/web.ts](/home/david/code/clawdad/src/channels/web.ts)
- [src/db.ts](/home/david/code/clawdad/src/db.ts)
- [src/index.ts](/home/david/code/clawdad/src/index.ts)

### 2. Move meta checks out of `/api/telemetry`

Do not award achievements as a side effect of a stats request.

Instead, evaluate:

- `centurion` on user message insert
- `streak_7` and `streak_30` on first user activity of the day, or on message insert with lightweight streak recomputation

The telemetry endpoint can still report progress, but it should not be the mechanism that advances it.

### 3. Make client state canonical-by-refresh

Keep the fast toast UX, but do not rely on optimistic XP accumulation as the long-lived source of truth.

Recommended change:

- on achievement SSE:
  - show toast immediately
  - update local unlocked set if desired
  - then refresh `/api/achievements`

At minimum, dedupe by achievement ID before adding XP locally.

### 4. Remove or repurpose stale persisted streak state

Right now streak lives both:

- in persisted achievement state
- and in derived telemetry calculation

We should pick one source of truth.

Recommendation:

- make streak derived from message history for now
- remove the persisted `streak` field from the long-term model unless we need it later for optimization

## Phase 2: Improve Progression Feel

### Goal

Make the system feel alive after the bug fixes.

### 1. Redesign level thresholds

Replace the flat `500 XP per level` model with an early-friendly curve.

Example cumulative thresholds:

- Level 1: 0 XP
- Level 2: 100 XP
- Level 3: 250 XP
- Level 4: 450 XP
- Level 5: 700 XP

This gives users a few quick wins early without making later levels trivial.

### 2. Add visible near-term progress

For tracked achievements, expose progress counters in the API and UI.

Examples:

- `Centurion`: `64 / 100`
- `Architect`: `2 / 3 active groups`
- `Assembly Line`: `2 / 3 scheduled tasks`
- `Streak`: `3 / 7 days`

This matters a lot psychologically. Even before the unlock, the system feels active.

### 3. Improve achievement grouping

Right now the panel groups by tier, which is fine, but the most motivating slice is often:

- unlocked recently
- close to unlocking
- foundational firsts

Recommendation:

- keep tier sections
- add a top summary module for:
  - next likely unlock
  - streak progress
  - current level target

## Phase 3: Add Sustainable XP Flow

### Goal

Prevent XP from going flat after first-time exploration.

### Recommendation

Introduce limited repeatable XP sources, with caps.

Examples:

- first message of the day: `+5 XP`
- first successful scheduled run of the day: `+10 XP`
- first delegation workflow completed today: `+10 XP`
- first thread reply of the day: `+5 XP`

Important:

- cap repeatables per day
- keep achievements more valuable than routine grinding
- prevent spam loops from becoming the optimal XP strategy

This lets the system reward ongoing engagement without undermining milestone achievements.

## Phase 4: Expand Expressive Achievements

Once the foundation is solid, we can support richer achievement types:

- hidden achievements
- chain achievements
- per-pack mastery achievements
- team-based achievements
- provider/runtime achievements later

But these should wait until the core model is trustworthy.

## Proposed Refactor Shape

### New types

Potential additions:

```typescript
interface AchievementProgress {
  current: number;
  target: number;
  label?: string;
}

interface AchievementResponse {
  definitions: AchievementDef[];
  state: AchievementState;
  progress: Record<string, { unlocked: number; total: number }>;
  tracked: Record<string, AchievementProgress>;
  level: {
    current: number;
    currentXp: number;
    nextLevelXp: number | null;
    progressPct: number;
  };
}
```

### New helper surface

Potential service functions:

```typescript
recordAchievementEvent(event: AchievementEvent): AchievementDef[];
maybeUnlockAchievement(id: string, group: string): AchievementDef | null;
getTrackedAchievementProgress(): Record<string, AchievementProgress>;
getLevelInfo(xp: number): LevelInfo;
```

This gives us a cleaner split between:

- raw unlock logic
- tracked counters
- UI-facing progression math

## Suggested Event Mapping

Use explicit app events for deterministic unlocks.

Examples:

```typescript
type AchievementEvent =
  | { type: 'user_message_sent'; jid: string }
  | { type: 'thread_reply_sent'; jid: string; threadId: string }
  | { type: 'task_created'; groupFolder: string }
  | { type: 'task_run_succeeded'; taskId: string; groupFolder: string }
  | { type: 'group_created'; groupFolder: string }
  | { type: 'triggered_agent_created'; groupFolder: string; agentId: string };
```

Then map them to rules:

- first `user_message_sent` → `first_contact`
- first `task_created` → `clockwork`
- first `thread_reply_sent` → `thread_weaver`
- first `triggered_agent_created` → `specialist`
- group count >= 3 → `architect`
- task count >= 3 → `assembly_line`

## Testing Plan

### Phase 1 tests

- Creating the first scheduled task unlocks `clockwork` without any agent involvement
- Sending the first message unlocks `first_contact`
- Replying in a thread unlocks `thread_weaver`
- Creating the first triggered agent unlocks `specialist`
- Meta achievements still unlock even if `/api/telemetry` is never called
- Duplicate SSE events do not double-add XP in the client

### Phase 2 tests

- Level transitions occur at the expected thresholds
- Near-term progress counters match DB state
- The achievement panel reflects canonical server XP after reload

### Phase 3 tests

- Repeatable XP respects daily caps
- Spammy repeated actions do not accumulate uncapped XP

## Recommended Order

### Step 1

Fix correctness:

- deterministic unlock hooks
- decouple meta from telemetry polling
- canonical refresh on unlock

### Step 2

Fix feel:

- better level curve
- tracked progress counters

### Step 3

Fix long-term momentum:

- capped repeatable XP sources

## What I Would Do First

If we want the smallest high-impact pass, start here:

1. server-side deterministic unlocks for `first_contact`, `clockwork`, `thread_weaver`, `specialist`, `architect`, `assembly_line`
2. move `centurion` and streak checks out of `/api/telemetry`
3. make the client refresh achievements after unlock SSE
4. replace the flat level formula with threshold-based progression

That would address both:

- "is this even working?"
- and
- "why does this feel frozen?"

without needing a full redesign on day one.
