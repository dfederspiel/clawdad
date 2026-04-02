# Design: Multi-Agent Groups

**Status:** MVP spike complete
**Date:** 2026-04-02
**Updated:** 2026-04-02 (post-spike learnings)

## Problem

Today, one group = one agent. This forces awkward workarounds for legitimate use cases:

- **Epic watcher** — you want one "group" watching several Jira epics, but each ticket needs its own agent with distinct instructions. Today you'd create N separate groups, cluttering the sidebar.
- **Sub-orchestrator** — you want a team of agents collaborating on a broader task (researcher + implementer + reviewer). Today there's no way for agents within a shared context to talk to each other.
- **Scaling a pattern** — you find a good agent template and want 3 instances with slight variations. Each one is a top-level group with its own chat, polluting the nav.

The core issue: **group** conflates two things — a shared context boundary and an agent identity. Separating them unlocks all three use cases.

## Design Principle

**Every group is multi-agent.** A group with one agent is the default, not a special case. No `type: "1:1" | "1:n"` field — that's just a group with `agents.length === 1`.

---

## Concepts

### Group (unchanged role, new internals)

A group remains the top-level organizational unit:
- Owns a folder on disk (`groups/{folder}/`)
- Has a JID and appears in the sidebar
- Has a shared message stream (the chat)
- Has shared memory (group-level `CLAUDE.md` becomes team context)
- Has scheduled tasks
- Has a trigger pattern (for the group as a whole)

**New:** a group contains one or more **agents**.

### Agent (new first-class concept)

An agent is an executor within a group:
- Has its own `CLAUDE.md` (identity, instructions)
- Has its own Claude session (isolated conversation history)
- Has its own trigger pattern (optional — defaults to responding to all group messages)
- Runs in its own container when active
- Can read the group's shared folder + global memory

---

## Folder Structure

### Before (today)

```
groups/
  web_general/
    CLAUDE.md          ← agent identity + group context mixed together
    group-config.json
    logs/
```

### After

```
groups/
  web_general/
    CLAUDE.md          ← group-level context (team charter, shared rules)
    group-config.json  ← group-level config (trigger, scope, mounts)
    agents/
      default/
        CLAUDE.md      ← agent identity ("You are General, a helpful assistant...")
        agent.json     ← agent-specific config (trigger override, etc.)
      researcher/
        CLAUDE.md
        agent.json
    logs/
```

**Backward compatibility:** If `agents/` doesn't exist, the system treats the group as having one implicit agent named `default` whose CLAUDE.md is the group's top-level CLAUDE.md. Migration moves it into `agents/default/CLAUDE.md` on first access.

### agent.json

```jsonc
{
  // Optional: agent-specific trigger (overrides group trigger for this agent)
  // If absent, agent responds to all messages routed to the group.
  "trigger": "@researcher",

  // Optional: container config overrides (timeout, mounts)
  "containerConfig": { "timeout": 600000 },

  // Optional: display name (defaults to folder name)
  "displayName": "Research Agent"
}
```

---

## Database Changes

### New table: `agents`

```sql
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,           -- '{group_folder}/{agent_name}'
  group_folder TEXT NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT,
  trigger_pattern TEXT,          -- NULL = responds to all group messages
  created_at TEXT NOT NULL,
  UNIQUE(group_folder, name)
);
```

### Modified table: `sessions`

```sql
-- Before:  sessions(group_folder TEXT PRIMARY KEY, session_id TEXT)
-- After:   sessions keyed by agent_id instead of group_folder
ALTER TABLE sessions ADD COLUMN agent_id TEXT;
-- Migration: existing rows get agent_id = '{group_folder}/default'
```

### Modified table: `agent_runs`

Add `agent_id TEXT` column so usage is tracked per-agent, not just per-group.

### No change to: `messages`, `registered_groups`, `scheduled_tasks`

Messages belong to the group's chat. Tasks belong to the group. The group is still the unit of identity for the outside world.

---

## Runtime Changes

### GroupQueue → tracks per-agent containers

Today `GroupQueue` maps `groupJid → GroupState` with one active container. After:

```typescript
interface AgentState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  process: ChildProcess | null;
  containerName: string | null;
  agentId: string;           // '{group_folder}/{agent_name}'
}

interface GroupState {
  agents: Map<string, AgentState>;  // agentName → state
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
}
```

**Concurrency:** The global `MAX_CONCURRENT_CONTAINERS` limit stays. Multiple agents in a group can run simultaneously, each consuming a slot. A group with 3 agents running = 3 slots used.

**Queue key change:** Today enqueue/dequeue uses `groupJid`. After, message routing still uses `groupJid` to find the group, but container lifecycle is keyed by `agentId` (`{folder}/{agentName}`).

### Container Runner

`buildVolumeMounts` changes:
- Group folder still mounts at `/workspace/group` (read-only for non-main agents)
- Agent's own folder mounts at `/workspace/agent` (read-write) — this is where the agent's CLAUDE.md lives
- Session directory moves from `data/sessions/{group_folder}/.claude/` to `data/sessions/{group_folder}/{agent_name}/.claude/`
- Agent-runner source is per-agent (already per-group today, just one level deeper)

`ContainerInput` gains:
```typescript
agentName: string;      // which agent within the group
agentId: string;        // '{group_folder}/{agent_name}'
```

### Message Routing

The flow for an inbound message:

```
1. Message arrives at group JID (unchanged)
2. Store in messages table (unchanged)
3. For each agent in the group:
   a. Check agent's trigger pattern (if set)
   b. If triggered (or no trigger = always), enqueue for that agent
4. Each triggered agent gets its own container invocation
5. Agent output → stored as a message in the group chat
   - sender_name set to agent's display name
   - Messages from other agents are visible in the prompt
     (they're just messages in the chat with different sender_name)
```

**Agent-to-agent communication** is emergent — it's just messages in the shared chat. Agent A responds, Agent B sees that response in its next invocation's message context. No special message bus needed.

### Agent Identity in Messages

Today all bot messages have `sender_name = ASSISTANT_NAME`. After:

```typescript
// Bot messages include the agent name
storeMessage({
  ...msg,
  sender_name: agent.displayName || agent.name,
  // New field to distinguish which agent sent it
  agent_id: agentId,
});
```

This means the prompt formatter can show:
```
[2026-04-02 10:30] researcher: Here's what I found about the ticket...
[2026-04-02 10:31] implementer: I'll start working on the fix based on that.
```

---

## Web UI Changes

### Sidebar

Groups remain the top-level nav items. No change to the group list. Inside a group chat, agent messages are distinguished by name/avatar.

### Group Settings (new)

A group's settings panel gets an "Agents" section showing:
- List of agents with name, trigger, status (active/idle)
- Add/remove agent buttons
- Per-agent CLAUDE.md editor

### Chat Display

Each message shows the agent name as the sender. Different agents could get different avatar colors (auto-assigned from agent name hash).

---

## Migration Path

### Phase 1: Spike (this PR)

Minimum viable changes to prove the architecture:

1. **Agent discovery** — on startup, scan `groups/{folder}/agents/` for agent subdirs. If none exist, synthesize an implicit `default` agent from the group's CLAUDE.md.
2. **Per-agent sessions** — change session key from `group_folder` to `group_folder/agent_name`.
3. **Per-agent containers** — GroupQueue tracks agent-level state. Container runner mounts agent CLAUDE.md.
4. **Multi-agent message routing** — when a group has multiple agents, each with a trigger, route accordingly.
5. **Agent name in messages** — bot messages carry the agent's display name.

**Not in spike:** UI for managing agents (create via filesystem/CLI only), agent-to-agent visibility (agents see only user messages initially), usage tracking per agent.

### Phase 2: Agent Interplay

- Agents see each other's messages in their prompt context
- Coordinator pattern: one agent can @-mention others
- Concurrency: multiple agents in a group running simultaneously

### Phase 3: UI & Management

- Web UI for adding/removing/configuring agents within a group
- Per-agent usage breakdown in telemetry
- Agent status indicators in sidebar subtitles
- Templates that define multi-agent groups

---

## Invariants

These must hold throughout all phases:

1. **A group with no `agents/` dir behaves exactly as today.** Zero regression for existing single-agent groups.
2. **Global concurrency limit is respected.** N agents in a group ≠ N free slots. They compete for the same pool.
3. **Messages belong to the group, not the agent.** The chat is shared. Agents are participants, not owners.
4. **Sessions are per-agent.** Two agents in the same group must never share a Claude session.
5. **IPC is per-group.** Tasks and credentials are group-level resources. Agents within a group share the IPC namespace (they're trusted peers).
6. **The group folder is the security boundary.** Agents within a group can read each other's CLAUDE.md. Cross-group isolation is unchanged.

---

## Spike Learnings (2026-04-02)

### What worked
- Agent discovery from filesystem, per-agent sessions/containers, identity on messages
- User @mentions as direct triggers (anywhere in message, not start-anchored)
- Coordinator pattern: triggerless agent as default responder + dispatcher
- Multi-agent context auto-injection telling agents their role and teammates
- @mention highlighting in rendered messages + autocomplete in chat input
- Expandable group sidebar showing agents

### What failed and was removed
- **Output text scanning for cross-agent triggers** — parsing agent output with regex to detect @mentions for handoff. Failed because: agents mention triggers conversationally (listing teammates), self-triggering loops, intent vs mention ambiguity, `_close` sentinel race conditions. Replaced with explicit MCP tool delegation.
- **Input textarea highlight overlay** — transparent text + visible overlay for @mention highlighting. Cursor position offset and text doubling. Removed.

### Key architectural decisions
1. **Coordinator-only delegation** — only the triggerless coordinator agent gets `delegate_to_agent`. Specialists hand back via output text. Prevents crosstalk spirals.
2. **Delegation via task queue** — delegations go through `GroupQueue.enqueueTask`, not direct `runAgent` calls. Prevents queue state corruption when multiple containers try to register for the same JID.
3. **Delegation timeout** — delegated containers get 2-minute hard timeout to prevent queue blocking from rate limits or hung SDK calls.
4. **Agent trigger patterns match anywhere** — `buildAgentTriggerPattern` uses `(?:^|\s)@trigger\b` vs group triggers which use `^@trigger\b`. Natural for mid-sentence mentions.
5. **First-mentioned agent runs first** — when multiple agents trigger on the same message, they're sorted by mention position. Only the first-mentioned runs; others are deferred to cross-agent routing.
6. **Shared workspace** — all agents mount `/workspace/group/` (the group folder). Artifacts written there are visible to all agents. This is the context bridge between agents.

### Context hierarchy
- `/workspace/group/CLAUDE.md` — group-level context (team charter), loaded by Claude Code SDK
- `/workspace/agent/CLAUDE.md` — agent identity, mounted for explicit agents
- `/workspace/global/CLAUDE.md` — global context, read-only
- Multi-agent context block — auto-injected into prompts, describes role and delegation mechanics
- Delegation prompt — includes conversation history + delegation instructions from coordinator

### Open Questions (updated)

1. **Per-agent queue slots (Phase 2)** — sequential queue blocks on hung containers. Need per-agent concurrency so delegations don't block each other.
2. **Shared context visibility** — agents don't see each other's tool calls or reasoning, only chat messages and shared files. The coordinator's delegation message is the explicit context bridge. Is this sufficient?
3. **Multi-agent setup wizard** — pre-built agent templates calibrated to work as teams. Coordinator + specialist packs.
4. **Task ownership** — scheduled tasks assignable to specific agents within a group.
5. **Agent lifecycle management** — UI for adding/removing agents, hot-reload on filesystem changes.
