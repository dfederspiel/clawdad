# Manual Container Testing & Reference

## Test the full agent flow

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

## Test Claude Code directly

```bash
docker run --rm --entrypoint /bin/bash \
  -v $(pwd)/data/env:/workspace/env-dir:ro \
  nanoclaw-agent:latest -c '
  export $(cat /workspace/env-dir/env | xargs)
  claude -p "Say hello" --dangerously-skip-permissions --allowedTools ""
'
```

## Interactive shell in container

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
docker images

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

Claude sessions are stored per-group in `data/sessions/{group}/.claude/` for security isolation.

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

# Also clear the session ID from NanoClaw's tracking
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = '{groupFolder}'"
```

To verify session resumption is working:
```bash
grep "Session initialized" logs/nanoclaw.log | tail -5
# Should show the SAME session ID for consecutive messages in the same group
```
