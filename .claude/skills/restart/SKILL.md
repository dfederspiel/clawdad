---
name: restart
description: Build TypeScript and restart the ClawDad service. Use when the user says "restart", "rebuild", "bounce", or after making code changes that need to take effect. Does NOT pull code — use /update for that.
---

# ClawDad Restart

Build and restart the running service. No git operations.

## Steps

### 1. Build

```bash
npm run build
```

If the build fails, show the error and stop. Don't restart with a broken build.

### 2. Detect service unit

```bash
systemctl --user list-units --type=service --state=running 2>/dev/null | grep -oE '(com-nanoclaw[^ ]+|nanoclaw)\.service' | head -1
```

### 3. Restart

If a service unit was found:

```bash
systemctl --user restart "$UNIT_NAME"
sleep 3
systemctl --user status "$UNIT_NAME" --no-pager | head -5
```

If no service unit is found (dev mode):

```bash
echo "No systemd service found. Stop any running instance and start manually:"
echo "  node dist/index.js"
```

### 4. Verify

```bash
curl -sf http://localhost:3456/api/health | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"docker={d['docker']['status']} proxy={d['credential_proxy']['status']} image={d['container_image']['status']}\")"
```

### Critical rule

**NEVER use `kill` on the node process directly.** The service has `Restart=always` — killing it just causes systemd to respawn the old build, creating zombie processes and port conflicts. Always use `systemctl --user restart`.
