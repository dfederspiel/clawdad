# Common Issues

## Container Exit 137 (SIGKILL)

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
- **1-second SIGTERM->SIGKILL gap**: Docker client disconnection (the `docker run` child process died)
- **10-second gap**: Normal `docker stop` — check `stopContainer` stack trace logs
- **No SIGTERM, just SIGKILL**: OOM killer — check `docker stats` for memory pressure

**Step 4: Check for concurrent instances**
```bash
ps aux | grep 'dist/index.js' | grep -v grep  # Should be exactly ONE
```

**Step 5: Instrument (if steps 1-4 don't resolve)**
`container-runner.ts` has lifecycle listeners on the `docker run` child process (exit code, signal, elapsed time). Check logs for `docker run child process exited` entries to correlate child process death with container death.

## "Claude Code process exited with code 1"

**Check the container log file** in `groups/{folder}/logs/container-*.log`

Common causes:

### Missing Authentication
```
Invalid API key / Please run /login
```
**Fix:** Ensure `.env` file exists with either OAuth token or API key:
```bash
cat .env  # Should show one of:
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...  (subscription)
# ANTHROPIC_API_KEY=sk-ant-api03-...        (pay-per-use)
```

### Root User Restriction
```
--dangerously-skip-permissions cannot be used with root/sudo privileges
```
**Fix:** Container must run as non-root user. Check Dockerfile has `USER node`.

## Environment Variables Not Passing

**Runtime note:** Environment variables passed via `-e` may be lost when using `-i` (interactive/piped stdin).

**Workaround:** The system extracts only authentication variables (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) from `.env` and mounts them for sourcing inside the container. Other env vars are not exposed.

To verify env vars are reaching the container:
```bash
echo '{}' | docker run -i \
  -v $(pwd)/data/env:/workspace/env-dir:ro \
  --entrypoint /bin/bash nanoclaw-agent:latest \
  -c 'export $(cat /workspace/env-dir/env | xargs); echo "OAuth: ${#CLAUDE_CODE_OAUTH_TOKEN} chars, API: ${#ANTHROPIC_API_KEY} chars"'
```

## Mount Issues

**Container mount notes:**
- Docker supports both `-v` and `--mount` syntax
- Use `:ro` suffix for readonly mounts

To check what's mounted inside a container:
```bash
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c 'ls -la /workspace/'
```

Expected structure:
```
/workspace/
├── env-dir/env           # Environment file
├── group/                # Current group folder (cwd)
├── project/              # Project root (main channel only)
├── global/               # Global CLAUDE.md (non-main only)
├── ipc/                  # Inter-process communication
│   ├── messages/         # Outgoing messages
│   ├── tasks/            # Scheduled task commands
│   ├── current_tasks.json
│   └── available_groups.json
└── extra/                # Additional custom mounts
```

## Permission Issues

The container runs as user `node` (uid 1000). Check ownership:
```bash
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  whoami
  ls -la /workspace/
  ls -la /app/
'
```

All of `/workspace/` and `/app/` should be owned by `node`.

## Session Not Resuming

If sessions aren't being resumed (new session ID every time), or Claude Code exits with code 1 when resuming:

**Root cause:** The SDK looks for sessions at `$HOME/.claude/projects/`. Inside the container, `HOME=/home/node`, so it looks at `/home/node/.claude/projects/`.

**Check the mount path:**
```bash
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

**Fix:** Ensure `container-runner.ts` mounts to `/home/node/.claude/` (NOT `/root/.claude/`).

## MCP Server Failures

If an MCP server fails to start, the agent may exit. Check the container logs for MCP initialization errors.
