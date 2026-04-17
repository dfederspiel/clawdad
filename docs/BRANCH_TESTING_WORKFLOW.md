# ClawDad Branch Testing Workflow

Use this when a feature branch changes routes, runtime behavior, orchestration, or any web-visible functionality and you want a repeatable way to verify the running WSL service is actually serving the new code.

## WSL Web Service

For this checkout, the expected service is:

- unit: `com-nanoclaw-clawdad.service`
- repo: `/home/david/code/clawdad`
- web UI: `http://localhost:3456`

## Typical Failure Mode

If a new route returns `404` or the UI looks stale even though the branch has the code, the most common cause is:

1. the branch source changed
2. `dist/` was not rebuilt, or
3. the systemd user service was not restarted after the rebuild

The running process will continue serving the old in-memory build until restart.

## Standard Verification Loop

### 1. Confirm branch and working tree

```bash
git status -sb
git branch --show-current
```

### 2. Rebuild the app

```bash
cd /home/david/code/clawdad
npm run build
```

### 3. Restart the WSL user service

```bash
systemctl --user restart com-nanoclaw-clawdad.service
systemctl --user status com-nanoclaw-clawdad.service --no-pager
```

Expected result:

- service shows `active (running)`
- the process command points at `/home/david/code/clawdad/dist/index.js`

### 4. Verify the route or behavior directly

Example runtime inspection endpoint:

```bash
curl -sS http://127.0.0.1:3456/api/groups/test-team/agents/coordinator/runtime-profile | jq
```

General health check:

```bash
curl -sS http://127.0.0.1:3456/api/health
```

### 5. Validate message flow when behavior changes

```bash
SINCE=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
curl -sf -X POST http://127.0.0.1:3456/api/send \
  -H 'Content-Type: application/json' \
  -d '{"jid":"web:test-team","content":"test message","sender":"David"}'
curl -sf "http://127.0.0.1:3456/api/messages/web:test-team?since=${SINCE}"
```

## If The Route Still Looks Wrong

Check what owns the ports:

```bash
lsof -iTCP:3456 -sTCP:LISTEN -n -P
lsof -iTCP:3457 -sTCP:LISTEN -n -P
```

The known-good state is:

- `3456` is served by `/home/david/code/clawdad/dist/index.js`
- `3457` is owned by the same running ClawDad process

If you see an older checkout or stale node process holding the port, stop that process and rerun the rebuild + restart sequence.

## Instruction Changes

If you changed a group's `CLAUDE.md`, warm pool containers may still hold the old instructions. Force a cold start for the affected agent:

```bash
docker ps --format '{{.Names}}' | grep <agent> | xargs -r docker stop
```

## Notes For Future Runtime Tests

For runtime/provider work, the minimum useful verification set is:

- rebuild
- restart service
- hit the runtime inspection endpoint
- send a message through the web API
- confirm logs and behavior match the branch
