---
name: debug
description: Debug container agent issues. Use when things aren't working, container fails, authentication problems, multi-agent delegation chains stall, messages not being processed, message routing issues, or to understand how the container system works. Covers logs, environment variables, mounts, multi-agent orchestration tracing, warm pool diagnostics, and common issues.
---

# NanoClaw Container Debugging

This guide covers debugging the containerized agent execution system.

## Architecture Overview

```
Host (macOS)                          Container (Linux VM)
─────────────────────────────────────────────────────────────
src/container-runner.ts               container/agent-runner/
    │                                      │
    │ spawns container                      │ runs Claude Agent SDK
    │ with volume mounts                   │ with MCP servers
    │                                      │
    ├── data/env/env ──────────────> /workspace/env-dir/env
    ├── groups/{folder} ───────────> /workspace/group
    ├── data/ipc/{folder} ────────> /workspace/ipc
    ├── data/sessions/{folder}/.claude/ ──> /home/node/.claude/ (isolated per-group)
    └── (main only) empty marker ──> /workspace/project
```

**Important:** The container runs as user `node` with `HOME=/home/node`. Session files must be mounted to `/home/node/.claude/` (not `/root/.claude/`) for session resumption to work.

## Log Locations

**IMPORTANT:** The log file depends on how ClawDad was started:

| Launch method | Log file | Error log |
|---------------|----------|-----------|
| `launchctl` service | `logs/clawdad.log` | `logs/clawdad.error.log` |
| `npm run dev` / manual | `logs/nanoclaw.log` | `logs/nanoclaw.error.log` |

To check which log the running instance uses:
```bash
launchctl print gui/$(id -u)/com.clawdad.clawdad 2>&1 | grep "stdout path"
```

| Log | Content |
|-----|---------|
| **Main app logs** | Host-side routing, container spawning, agent lifecycle |
| **Container run logs** (`groups/{folder}/logs/container-*.log`) | Per-run: input, mounts, stderr, stdout |
| **Claude sessions** (`~/.claude/projects/`) | Claude Code session history |

## Enabling Debug Logging

Set `LOG_LEVEL=debug` for verbose output:

```bash
# For development
LOG_LEVEL=debug npm run dev

# For launchd service (macOS), add to plist EnvironmentVariables:
<key>LOG_LEVEL</key>
<string>debug</string>
# For systemd service (Linux), add to unit [Service] section:
# Environment=LOG_LEVEL=debug
```

Debug level shows:
- Full mount configurations
- Container command arguments
- Real-time container stderr

## Common Issues

### 0. Container Exit 137 (SIGKILL)

Exit code 137 = 128 + signal 9 (SIGKILL). The container was forcibly killed. **Do not deep-dive into code first — work the triage checklist:**

**Step 1: Restart the service**
```bash
kill $(pgrep -f 'node dist/index.js')
# launchd auto-restarts — verify:
sleep 3 && curl -sf http://localhost:3456/api/health | python3 -c "import sys,json; print(json.load(sys.stdin)['overall'])"
```
Re-send a test message. If the issue stops, it was accumulated process state (the most common cause).

**Step 2: Check for stale/competing services**
```bash
launchctl list | grep -iE 'claw|nanoclaw'
# Only com.clawdad.clawdad should exist. Remove others:
# launchctl bootout gui/$(id -u)/<stale-name>
# rm ~/Library/LaunchAgents/<stale-name>.plist
```

**Step 3: Check Docker events**
```bash
docker events --filter event=kill --filter event=die --since 5m \
  --format '{{.Time}} {{.Action}} signal={{.Actor.Attributes.signal}} execDur={{.Actor.Attributes.execDuration}} name={{.Actor.Attributes.name}}'
```
- **1-second SIGTERM→SIGKILL gap**: Docker client disconnection (the `docker run` child process died)
- **10-second gap**: Normal `docker stop` — check `stopContainer` stack trace logs
- **No SIGTERM, just SIGKILL**: OOM killer — check `docker stats` for memory pressure

**Step 4: Check for concurrent instances**
```bash
ps aux | grep 'dist/index.js' | grep -v grep  # Should be exactly ONE
```

**Step 5: Instrument (if steps 1-4 don't resolve)**
`container-runner.ts` has lifecycle listeners on the `docker run` child process (exit code, signal, elapsed time). Check logs for `docker run child process exited` entries to correlate child process death with container death.

### 1. "Claude Code process exited with code 1"

**Check the container log file** in `groups/{folder}/logs/container-*.log`

Common causes:

#### Missing Authentication
```
Invalid API key · Please run /login
```
**Fix:** Ensure `.env` file exists with either OAuth token or API key:
```bash
cat .env  # Should show one of:
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...  (subscription)
# ANTHROPIC_API_KEY=sk-ant-api03-...        (pay-per-use)
```

#### Root User Restriction
```
--dangerously-skip-permissions cannot be used with root/sudo privileges
```
**Fix:** Container must run as non-root user. Check Dockerfile has `USER node`.

### 2. Environment Variables Not Passing

**Runtime note:** Environment variables passed via `-e` may be lost when using `-i` (interactive/piped stdin).

**Workaround:** The system extracts only authentication variables (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) from `.env` and mounts them for sourcing inside the container. Other env vars are not exposed.

To verify env vars are reaching the container:
```bash
echo '{}' | docker run -i \
  -v $(pwd)/data/env:/workspace/env-dir:ro \
  --entrypoint /bin/bash nanoclaw-agent:latest \
  -c 'export $(cat /workspace/env-dir/env | xargs); echo "OAuth: ${#CLAUDE_CODE_OAUTH_TOKEN} chars, API: ${#ANTHROPIC_API_KEY} chars"'
```

### 3. Mount Issues

**Container mount notes:**
- Docker supports both `-v` and `--mount` syntax
- Use `:ro` suffix for readonly mounts:
  ```bash
  # Readonly
  -v /path:/container/path:ro

  # Read-write
  -v /path:/container/path
  ```

To check what's mounted inside a container:
```bash
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c 'ls -la /workspace/'
```

Expected structure:
```
/workspace/
├── env-dir/env           # Environment file (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY)
├── group/                # Current group folder (cwd)
├── project/              # Project root (main channel only)
├── global/               # Global CLAUDE.md (non-main only)
├── ipc/                  # Inter-process communication
│   ├── messages/         # Outgoing WhatsApp messages
│   ├── tasks/            # Scheduled task commands
│   ├── current_tasks.json    # Read-only: scheduled tasks visible to this group
│   └── available_groups.json # Read-only: WhatsApp groups for activation (main only)
└── extra/                # Additional custom mounts
```

### 4. Permission Issues

The container runs as user `node` (uid 1000). Check ownership:
```bash
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  whoami
  ls -la /workspace/
  ls -la /app/
'
```

All of `/workspace/` and `/app/` should be owned by `node`.

### 5. Session Not Resuming / "Claude Code process exited with code 1"

If sessions aren't being resumed (new session ID every time), or Claude Code exits with code 1 when resuming:

**Root cause:** The SDK looks for sessions at `$HOME/.claude/projects/`. Inside the container, `HOME=/home/node`, so it looks at `/home/node/.claude/projects/`.

**Check the mount path:**
```bash
# In container-runner.ts, verify mount is to /home/node/.claude/, NOT /root/.claude/
grep -A3 "Claude sessions" src/container-runner.ts
```

**Verify sessions are accessible:**
```bash
docker run --rm --entrypoint /bin/bash \
  -v ~/.claude:/home/node/.claude \
  nanoclaw-agent:latest -c '
echo "HOME=$HOME"
ls -la $HOME/.claude/projects/ 2>&1 | head -5
'
```

**Fix:** Ensure `container-runner.ts` mounts to `/home/node/.claude/`:
```typescript
mounts.push({
  hostPath: claudeDir,
  containerPath: '/home/node/.claude',  // NOT /root/.claude
  readonly: false
});
```

### 6. MCP Server Failures

If an MCP server fails to start, the agent may exit. Check the container logs for MCP initialization errors.

## Manual Container Testing

### Test the full agent flow:
```bash
# Set up env file
mkdir -p data/env groups/test
cp .env data/env/env

# Run test query
echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test@g.us","isMain":false}' | \
  docker run -i \
  -v $(pwd)/data/env:/workspace/env-dir:ro \
  -v $(pwd)/groups/test:/workspace/group \
  -v $(pwd)/data/ipc:/workspace/ipc \
  nanoclaw-agent:latest
```

### Test Claude Code directly:
```bash
docker run --rm --entrypoint /bin/bash \
  -v $(pwd)/data/env:/workspace/env-dir:ro \
  nanoclaw-agent:latest -c '
  export $(cat /workspace/env-dir/env | xargs)
  claude -p "Say hello" --dangerously-skip-permissions --allowedTools ""
'
```

### Interactive shell in container:
```bash
docker run --rm -it --entrypoint /bin/bash nanoclaw-agent:latest
```

## SDK Options Reference

The agent-runner uses these Claude Agent SDK options:

```typescript
query({
  prompt: input.prompt,
  options: {
    cwd: '/workspace/group',
    allowedTools: ['Bash', 'Read', 'Write', ...],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,  // Required with bypassPermissions
    settingSources: ['project'],
    mcpServers: { ... }
  }
})
```

**Important:** `allowDangerouslySkipPermissions: true` is required when using `permissionMode: 'bypassPermissions'`. Without it, Claude Code exits with code 1.

## Rebuilding After Changes

```bash
# Rebuild main app
npm run build

# Rebuild container (use --no-cache for clean rebuild)
./container/build.sh

# Or force full rebuild
docker builder prune -af
./container/build.sh
```

## Checking Container Image

```bash
# List images
docker images

# Check what's in the image
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  echo "=== Node version ==="
  node --version

  echo "=== Claude Code version ==="
  claude --version

  echo "=== Installed packages ==="
  ls /app/node_modules/
'
```

## Session Persistence

Claude sessions are stored per-group in `data/sessions/{group}/.claude/` for security isolation. Each group has its own session directory, preventing cross-group access to conversation history.

**Critical:** The mount path must match the container user's HOME directory:
- Container user: `node`
- Container HOME: `/home/node`
- Mount target: `/home/node/.claude/` (NOT `/root/.claude/`)

To clear sessions:

```bash
# Clear all sessions for all groups
rm -rf data/sessions/

# Clear sessions for a specific group
rm -rf data/sessions/{groupFolder}/.claude/

# Also clear the session ID from NanoClaw's tracking (stored in SQLite)
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = '{groupFolder}'"
```

To verify session resumption is working, check the logs for the same session ID across messages:
```bash
grep "Session initialized" logs/nanoclaw.log | tail -5
# Should show the SAME session ID for consecutive messages in the same group
```

## Multi-Agent Debugging

Multi-agent groups have a coordinator + specialists pattern. Debugging requires tracing the delegation chain.

### Trace a delegation chain

```bash
# Show all delegation events for a group
grep -E "delegation|Delegation|delegat" logs/clawdad.log | grep "Test Team"

# Show the full orchestration flow: delegations, completions, re-triggers
grep -E "delegation|All delegations complete|Processing messages|Spawning container" logs/clawdad.log | tail -30
```

### Key log patterns to look for

| Pattern | Meaning |
|---------|---------|
| `Processing agent delegation` | Coordinator called delegate_to_agent |
| `Spawning container agent` (with agent name in container name) | Specialist container starting |
| `Delegation complete` | Specialist finished and exited |
| `All delegations complete, re-triggering coordinator` | All specialists done, coordinator will re-spawn |
| `Processing messages ... agents: ["coordinator"]` | Coordinator re-triggered to synthesize |

### Common multi-agent issues

**Coordinator doesn't re-trigger after delegations:**
- Check that `"All delegations complete"` appears in logs
- If it does but no `"Processing messages"` follows: the message loop may have advanced the cursor. Multi-agent groups should NEVER use the piping path — check `isMultiAgent` guard in `startMessageLoop`.
- Verify the cursor: `sqlite3 store/messages.db "SELECT value FROM router_state WHERE key='last_agent_timestamp'"`

**Wrong agent name on messages ("Andy" instead of agent name):**
- `setActiveAgentName` must be called before each `sendMessage` (not just once per run)
- Parallel containers clobber the shared `activeAgentNames` map — each callback must re-assert

**Specialist container doesn't exit promptly:**
- Delegation containers should exit immediately (no idle loop). Check that `containerInput.isDelegation` is `true` in the agent-runner.
- Container rebuild may be needed: `CONTAINER_RUNTIME=docker ./container/build.sh`

**Delegation never starts (coordinator finishes without delegating):**
- Check coordinator's CLAUDE.md includes delegation instructions
- Verify `buildMultiAgentContext` is injecting the `delegate_to_agent` tool hint
- Check `NANOCLAW_CAN_DELEGATE` is `1` for the coordinator container

### Per-agent container logs

Agent containers are named with the agent: `nanoclaw-{group}-{agent}-{timestamp}`.

```bash
# List active containers for a group
docker ps --filter "name=nanoclaw-web-test-team" --format "{{.Names}} {{.Status}}"

# Check a specific agent's last run
ls -t groups/web_test-team/logs/container-*.log | head -3
```

### Check agent discovery

```bash
# Verify agents are discovered on startup
grep "Discovered agents" logs/clawdad.log | tail -5

# Check agent folder structure
ls -la groups/web_test-team/agents/*/
cat groups/web_test-team/agents/*/agent.json
```

## IPC Debugging

The container communicates back to the host via files in `/workspace/ipc/`:

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
- `messages/*.json` - Agent writes: outgoing WhatsApp messages
- `tasks/*.json` - Agent writes: task operations (schedule, pause, resume, cancel, refresh_groups)
- `current_tasks.json` - Host writes: read-only snapshot of scheduled tasks
- `available_groups.json` - Host writes: read-only list of WhatsApp groups (main only)

## Quick Diagnostic Script

Run this to check common issues:

```bash
echo "=== Checking NanoClaw Container Setup ==="

echo -e "\n1. Authentication configured?"
[ -f .env ] && (grep -q "CLAUDE_CODE_OAUTH_TOKEN=sk-" .env || grep -q "ANTHROPIC_API_KEY=sk-" .env) && echo "OK" || echo "MISSING - add CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY to .env"

echo -e "\n2. Env file copied for container?"
[ -f data/env/env ] && echo "OK" || echo "MISSING - will be created on first run"

echo -e "\n3. Container runtime running?"
docker info &>/dev/null && echo "OK" || echo "NOT RUNNING - start Docker Desktop (macOS) or sudo systemctl start docker (Linux)"

echo -e "\n4. Container image exists?"
echo '{}' | docker run -i --entrypoint /bin/echo nanoclaw-agent:latest "OK" 2>/dev/null || echo "MISSING - run ./container/build.sh"

echo -e "\n5. Session mount path correct?"
grep -q "/home/node/.claude" src/container-runner.ts 2>/dev/null && echo "OK" || echo "WRONG - should mount to /home/node/.claude/, not /root/.claude/"

echo -e "\n6. Groups directory?"
ls -la groups/ 2>/dev/null || echo "MISSING - run setup"

echo -e "\n7. Recent container logs?"
ls -t groups/*/logs/container-*.log 2>/dev/null | head -3 || echo "No container logs yet"

echo -e "\n8. Session continuity working?"
SESSIONS=$(grep "Session initialized" logs/nanoclaw.log 2>/dev/null | tail -5 | awk '{print $NF}' | sort -u | wc -l)
[ "$SESSIONS" -le 2 ] && echo "OK (recent sessions reusing IDs)" || echo "CHECK - multiple different session IDs, may indicate resumption issues"
```
