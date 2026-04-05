# Design: Container Activity Feed

**Status:** Roadmap  
**Priority:** Medium  
**Depends on:** Typing indicator fix (Phase 0)

## Problem

The only way to see what's happening inside a running container is `docker logs`. The web UI shows a typing indicator during runs, but it's ephemeral — once the run ends (or between SDK turns), all evidence of activity vanishes. For multi-agent delegations especially, there's no visibility into the orchestrator-agent conversation or the agent's internal tool work.

Users need:
1. **Liveness signal** — is the container doing something right now?
2. **Message visibility** — what's being said between orchestrator and agent, and what tools is the agent calling?

## Current State

The data is mostly already flowing through the system:

| Data | Source | Currently surfaced |
|------|--------|--------------------|
| Tool calls (name + summary) | PROGRESS markers → `agent_progress` SSE | Typing indicator (ephemeral) |
| Intermediate text | TEXT markers → `sendMessage` | Chat messages |
| Final output + usage | OUTPUT markers | Chat message + usage footer |
| Orchestrator → agent prompt | Container log files on disk | Not surfaced |
| Work state (idle/working) | `work_state` SSE | Status dot on group card |

**Gap:** Progress events and work state are fire-and-forget. Once the typing indicator clears, the activity history is gone. The transcript endpoint (`/api/transcript`) captures tool calls but only after the run completes.

## Phased Approach

### Phase 0: Fix the Typing Gap (prerequisite)

The typing indicator goes silent between SDK turns (10-30s gaps). This must be fixed first because the activity feed builds on the same event stream.

**Changes:**
- Emit a progress event in `container/agent-runner/src/index.ts` when a `tool_result` message arrives from the SDK (signals "processing tool result, next turn coming")
- Consider emitting `work_state` sub-phases: `thinking` / `tool_executing` / `tool_processing`
- This gives the typing indicator continuous signal and establishes the event vocabulary for Phase 1

### Phase 1: Persistent Activity Timeline

Replace the ephemeral typing indicator with a persistent, scrollable activity stream per group. The typing indicator becomes the *live tail* of this stream rather than a standalone widget.

**Key idea:** The typing indicator already receives `agent_progress` events. Instead of displaying only the latest one, accumulate them into a timeline that persists after the run ends.

**Backend:**
- Store progress events in a lightweight ring buffer or append-only table (not just SSE fire-and-forget)
- Add orchestrator → agent direction: emit an SSE event when a prompt is sent to a container (the data is already in the container log — just surface it)
- Extend `/api/transcript` to include progress events inline with messages, or create a new `/api/activity?group=folder` endpoint

**Frontend:**
- Activity panel (collapsible, per-group) showing chronological stream:
  - `→ agent` Orchestrator sent prompt (truncated preview)
  - `⚙ tool` Agent called Read("/workspace/group/data.csv") 
  - `⚙ tool` Agent called Bash("python analyze.py")
  - `← text` Agent emitted intermediate text
  - `✓ done` Agent completed (2.3s, 1.2k tokens, $0.003)
- For multi-agent groups, prefix entries with agent name
- Live entries animate in; historical entries are static

### Phase 2: Multi-Agent Delegation Visibility

For groups with multiple agents, show the delegation fan-out:

- Coordinator delegates to specialist → show as a branching timeline
- Parallel delegations shown side-by-side or with swimlanes
- Each delegation's activity is independently scrollable
- When all delegations complete, show the coordinator re-trigger

This builds naturally on Phase 1 — same event types, just grouped by agent.

### Phase 3: Agent Direct Line (Calibration Mode)

From the activity feed, open an isolated chat session with a specific agent — bypassing group routing entirely. This lets you talk to an agent 1:1 to calibrate its behavior, test its responses, and tune its CLAUDE.md without polluting the group conversation.

**Why this matters:** Calibrating an agent today means sending messages through the group, which triggers the coordinator, other specialists, and the full routing pipeline. You can't isolate a single agent's behavior. For multi-agent teams, this makes the difference between "hope the coordinator routes correctly" and "I know this specialist handles X well because I tested it directly."

**What it looks like:**
- Click an agent in the activity feed → opens a side panel or overlay chat
- Messages go directly to that agent's container (no trigger matching, no coordinator)
- Agent gets its full context: its CLAUDE.md, group CLAUDE.md, shared `/workspace/group/`
- Responses stream back into this isolated view with the same activity timeline
- Edits to the agent's CLAUDE.md are visible inline — change instructions, send a test message, see if behavior improves

**Architecture — surprisingly minimal:**

The container-runner already supports agent identity independent of group routing. Each agent has its own `agentId`, session, CLAUDE.md, and IPC namespace. The group routing in `processGroupMessages` is just one entry point — not a deep coupling.

New pieces:
1. **API endpoint:** `POST /api/agents/:groupFolder/:agentName/message` — constructs `ContainerInput` directly, calls `spawnContainer()` targeting the specific agent, streams response back
2. **Session isolation:** Use `{groupFolder}/{agentName}/calibration` as the session key so calibration conversations don't bleed into production sessions
3. **Frontend:** Chat panel that targets the agent-direct endpoint instead of `/api/send`. Reuses existing message components + the new activity timeline from Phase 1
4. **Optional: CLAUDE.md editor** — inline editor for the agent's identity file, with a "test this change" button that sends a message immediately after saving

**What it does NOT need:**
- No changes to container-runner or agent-runner internals
- No changes to the IPC protocol
- No new container image
- Group routing is untouched — this is a parallel entry point, not a modification

**Estimated effort:** ~1-2 days. The hardest part is the frontend chat panel, but it's a simpler version of what already exists (single agent, no routing, no coordinator).

### Phase 4: Container Inspector

Optional deep-dive panel for a single container:

- Full stdout/stderr tail (already on disk in `groups/{folder}/logs/`)
- Container metadata (name, uptime, warm/cold, query count)
- Resource usage (requires `docker stats` polling — new capability)

## Architecture Notes

**The typing indicator is the unification point.** Rather than building a separate activity panel, evolve the typing indicator from "ephemeral status line" to "live activity feed with history." This means:

1. `agent_progress` events get stored (not just displayed and discarded)
2. The typing indicator component grows into an activity timeline component
3. The transition is incremental — Phase 0 is a bugfix, Phase 1 is a UI evolution

**Storage:** Progress events are high-volume but low-value individually. A capped SQLite table (last N events per group) or in-memory ring buffer is sufficient. No need to keep months of tool call history.

**SSE event reuse:** The existing `agent_progress` and `work_state` events carry the right data. Phase 1 adds one new event direction (orchestrator → agent). No protocol changes needed.
