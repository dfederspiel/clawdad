---
name: update
description: Pull the latest ClawDad code, rebuild, and restart the running service. Use when the user says "update", "pull latest", "upgrade", or wants to apply new code changes.
---

# ClawDad Update

Pull latest code, rebuild, and restart the service. Handles dependency changes, build failures, and service restarts gracefully.

## 1. Pre-flight

Check for uncommitted changes:
```bash
git status --porcelain
```

- **Clean** → proceed
- **Dirty** → warn the user and list the changed files. AskUserQuestion:
  1. **Stash and continue** — `git stash` before pulling, `git stash pop` after
  2. **Abort** — let the user handle it manually

Check which branch we're on:
```bash
git branch --show-current
```

If not on `main`, warn: "You're on branch `<name>`. Updates pull from `main`. Switch to main first?"

## 2. Pull

```bash
git pull origin main
```

If the pull fails (merge conflict), tell the user and stop. Don't try to auto-resolve.

Parse the output to determine what changed:
```bash
git diff HEAD@{1}..HEAD --stat
```

Note whether `package.json` or `package-lock.json` changed (needs `npm install`).
Note whether anything in `container/` changed (needs container rebuild).

## 3. Install dependencies (if needed)

Only if `package.json` or `package-lock.json` changed:
```bash
npm install
```

## 4. Build

```bash
npm run build
```

If the build fails, show the error and stop. Don't restart the service with a broken build.

## 5. Rebuild container (if needed)

Only if files in `container/` changed:
```bash
./container/build.sh
```

Tell the user this is happening — container builds take a minute or two.

## 6. Restart service

Detect the service label for this instance:
```bash
# The label is com.nanoclaw.<directory-name>
LABEL="com.nanoclaw.$(basename $(pwd))"
```

### macOS (launchd)

```bash
# Check if service is registered
launchctl list | grep "$LABEL"

# Restart it
launchctl kickstart -k "gui/$(id -u)/$LABEL"
```

If the service isn't registered (user runs in dev mode), tell them to restart manually:
```
npm run dev
```

### Linux (systemd)

```bash
UNIT_NAME=$(echo "$LABEL" | tr '.' '-')
systemctl --user restart "$UNIT_NAME"
```

## 7. Verify

Wait 3 seconds for the service to start, then check health:
```bash
# Read port from .env, default to 3456
PORT=$(grep -oP 'WEB_UI_PORT=\K\d+' .env 2>/dev/null || echo 3456)
curl -sf "http://localhost:$PORT/api/health" | python3 -m json.tool
```

If health check passes, tell the user:
> Updated and restarted. ClawDad is running at http://localhost:<PORT>.

If it fails, check the error log:
```bash
tail -20 logs/nanoclaw.error.log
```

## Summary format

After a successful update, show a concise summary:

```
Updated ClawDad to <short-hash>.
- <N> files changed
- Dependencies: updated / unchanged
- Container: rebuilt / unchanged
- Service: restarted on port <PORT>
```
