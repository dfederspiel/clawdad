# Multi-Agent Team Architecture Guide

## Context Flow

When a container starts, the agent sees these layers (in order):

1. **Group CLAUDE.md** (`/workspace/group/CLAUDE.md`) — shared standards, team charter
2. **Agent CLAUDE.md** (`/workspace/agent/CLAUDE.md`) — agent identity, specific workflows
3. **Multi-agent context** (auto-injected) — teammate list, delegation instructions, role clarification
4. **Container skills** (auto-loaded from `container/skills/`) — tools like agent-browser, credential-proxy

The agent does NOT see: other agents' CLAUDE.md files, the coordinator's conversation history, or other agents' workspaces.

## What Goes Where

### Group CLAUDE.md (shared by all agents)
- Team charter and purpose
- Shared API patterns (api.sh, credential proxy)
- Comment/output format standards
- Shared references table
- Team member directory (account IDs)
- Error handling and connectivity rules

### Agent CLAUDE.md (one agent only)
- Agent identity ("You are the Bug Coordinator")
- Agent-specific workflow steps
- Routing maps (coordinator) or code search patterns (specialists)
- Classification rules, PR workflow
- References to agent-specific files at `/workspace/agent/references/`

### References (detail overflow)
- Templates, lookup tables, detailed procedures
- Put at `/workspace/agent/references/` (agent-specific) or `/workspace/group/references/` (shared)
- Link with `Read /workspace/{scope}/references/filename.md`

**Anti-pattern:** Putting specialist-specific instructions in group CLAUDE.md bloats every agent's context. Putting shared standards in agent CLAUDE.md causes drift.

## Delegation Message Design

**CRITICAL:** Specialists run in separate containers and cannot see the coordinator's conversation. Every delegation must be self-contained.

### Required in every delegation:
- Task identifier (ticket ID, issue URL, etc.)
- Condensed context (relevant background the specialist needs)
- Specific scope (which files, components, or areas to investigate)
- Contact info (who to @mention for feedback)

### Do NOT include:
- References to "the message above" or "as discussed" — specialist can't see it
- Pre-determined conclusions — let the specialist analyze independently
- Ambiguous routing ("look into this") without specific paths

## Workspace Paths

| Path | Scope | Contents |
|------|-------|----------|
| `/workspace/group/` | All agents | Shared state, logs, artifacts |
| `/workspace/agent/` | One agent | Agent's CLAUDE.md, references/ |
| `/workspace/global/` | All groups | Sessions, credentials |
| `/workspace/extra/{name}/` | Mounted repos | Source code for analysis |
| `/workspace/ipc/` | Per-group | IPC messages, delegations |

## completion_policy Choices

| Policy | Behavior | Use when |
|--------|----------|----------|
| `"final_response"` | Specialist output goes to chat, coordinator is done | Specialist owns the full response |
| `"retrigger_coordinator"` | Specialist finishes, coordinator gets another turn | Coordinator needs to synthesize multiple results |
| `"none"` | Specialist runs, no follow-up | Fire-and-forget — specialist posts its own results |

## Common Architecture Mistakes

1. All agents have triggers — no coordinator, group can't auto-delegate
2. Specialist missing `"trigger"` in agent.json — treated as second coordinator
3. Coordinator doesn't document teammates or `delegate_to_agent` usage
4. Delegation messages reference coordinator's conversation ("as described above")
5. Shared standards duplicated in each agent CLAUDE.md instead of group CLAUDE.md
6. Agent-specific instructions in group CLAUDE.md bloating every agent's context
7. Using @mentions in chat instead of `delegate_to_agent` tool (does nothing)
8. Specialist trying to call `delegate_to_agent` (only coordinators can delegate)
9. Monolithic CLAUDE.md without references/ extraction (exceeds token budget)
10. Not reading mounted repos' CLAUDE.md — missing conventions and patterns
11. Mounting additional directories at reserved paths (`/workspace/agent/`, `/workspace/group/`)
12. Duplicate agent names or triggers within a group
13. Missing `agent.json` — agent discovery fails silently
14. Not testing with a cold start after editing CLAUDE.md (warm pool serves stale context)
