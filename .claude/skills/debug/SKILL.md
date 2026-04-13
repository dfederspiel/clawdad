---
name: debug
description: Debug container agent issues. Use when things aren't working, container fails, authentication problems, multi-agent delegation chains stall, messages not being processed, message routing issues, or to understand how the container system works. Covers logs, environment variables, mounts, multi-agent orchestration tracing, warm pool diagnostics, and common issues.
---

# NanoClaw Container Debugging

## Architecture Overview

```
Host (macOS)                          Container (Linux VM)
─────────────────────────────────────────────────────────────
src/container-runner.ts               container/agent-runner/
    │                                      │
    │ spawns container                     │ runs Claude Agent SDK
    │ with volume mounts                   │ with MCP servers
    │                                      │
    ├── data/env/env ──────────────> /workspace/env-dir/env
    ├── groups/{folder} ───────────> /workspace/group
    ├── data/ipc/{folder} ────────> /workspace/ipc
    ├── data/sessions/{folder}/.claude/ ──> /home/node/.claude/
    └── (main only) empty marker ──> /workspace/project
```

**Important:** Container runs as user `node` with `HOME=/home/node`. Session files must be mounted to `/home/node/.claude/`.

## Log Locations

| Launch method | Log file | Error log |
|---------------|----------|-----------|
| `launchctl` service | `logs/clawdad.log` | `logs/clawdad.error.log` |
| `npm run dev` / manual | `logs/nanoclaw.log` | `logs/nanoclaw.error.log` |

```bash
launchctl print gui/$(id -u)/com.clawdad.clawdad 2>&1 | grep "stdout path"
```

Container run logs: `groups/{folder}/logs/container-*.log`

## Enabling Debug Logging

```bash
LOG_LEVEL=debug npm run dev
```

## Debugging by Category

**Container crashes or exit codes** — Read `${CLAUDE_SKILL_DIR}/references/common-issues.md` for the full triage checklist covering exit 137, exit 1, auth failures, env vars, mounts, permissions, session resumption, and MCP errors.

**Multi-agent delegation issues** — Read `${CLAUDE_SKILL_DIR}/references/multi-agent-debugging.md` for delegation chain tracing, log patterns, common coordinator/specialist issues, per-agent logs, and agent discovery.

**Manual container testing, SDK options, rebuilding** — Read `${CLAUDE_SKILL_DIR}/references/manual-testing.md` for interactive shell access, test queries, SDK config, image inspection, and session persistence.

**Quick health check** — Read `${CLAUDE_SKILL_DIR}/references/diagnostic-script.md` for a comprehensive bash script that checks auth, Docker, image, mounts, groups, and session continuity.

## IPC Debugging

```bash
# Check pending messages
ls -la data/ipc/messages/

# Check pending task operations
ls -la data/ipc/tasks/

# Read a specific IPC file
cat data/ipc/messages/*.json

# Check available groups (main channel only)
cat data/ipc/main/available_groups.json

# Check current tasks snapshot
cat data/ipc/{groupFolder}/current_tasks.json
```

**IPC file types:**
- `messages/*.json` — Outgoing messages from agent
- `tasks/*.json` — Task operations (schedule, pause, resume, cancel)
- `current_tasks.json` — Read-only snapshot of scheduled tasks
- `available_groups.json` — Read-only list of groups (main only)
