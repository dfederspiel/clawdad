---
name: update
description: Pull the latest ClawDad code, rebuild, and restart the running service. Use when the user says "update", "pull latest", "upgrade", or wants to apply new code changes.
---

# ClawDad Update

Smart update that detects context and uses the right strategy.

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

## 2. Detect update mode

Determine the relationship between this repo and its remotes:

```bash
UPSTREAM_URL=$(git remote get-url upstream 2>/dev/null || echo "")
ORIGIN_URL=$(git remote get-url origin 2>/dev/null || echo "")
```

**Two modes:**

| Mode | Detection | Strategy |
|------|-----------|----------|
| **Fork mode** | `upstream` points to `dfederspiel/clawdad` (or no upstream, just origin) | Merge — `git pull` or `git fetch upstream main && git merge upstream/main` |
| **Source mode** | `upstream` points to `qwibitai/nanoclaw` | Cherry-pick — selective sync from upstream NanoClaw |

If `upstream` URL contains `qwibitai/nanoclaw` → **Source mode**.
Otherwise → **Fork mode**.

In both modes, always pull from `origin` first to catch cross-machine pushes:
```bash
git fetch origin main && git merge origin/main
```

## 3a. Fork mode (merge)

Standard merge from upstream:

```bash
git fetch upstream main && git merge upstream/main
```

If the merge fails (conflict), tell the user and stop. Don't try to auto-resolve.

Skip to **Step 4** (post-update).

## 3b. Source mode (cherry-pick from NanoClaw)

This mode exists because upstream NanoClaw runs periodic bulk formatting (prettier/eslint), version bumps, and token-count doc updates that create false conflicts on merge. We cherry-pick only the substantive changes.

### Fetch and analyze

```bash
git fetch upstream main
```

Find commits unique to upstream (patch-id deduped, excludes already-merged work):
```bash
git log --oneline --no-merges --cherry-pick --left-only upstream/main...HEAD
```

### Filter noise

Categorize each commit by its message. Skip commits matching these patterns — they cause conflicts and add no value:

- `chore: bump version` — version bumps
- `style: run prettier` or `style: run eslint` — bulk formatting
- `docs: update token count` — auto-generated token badges
- `chore: remove .* test` — test cleanup from upstream

### Present candidates

Show the user a numbered list of remaining commits with their short description. For each one, show the `--stat` so they can see what files are touched.

Ask the user which commits to take. Options:
- **All** — cherry-pick all candidates
- **Pick by number** — e.g., "1, 3, 5"
- **None** — skip sync, just do the origin pull + build

### Apply selected commits

For each selected commit, attempt cherry-pick:

```bash
git cherry-pick --no-commit <sha>
```

If it conflicts:
1. Show the conflicted files
2. Read each conflicted file and resolve — prefer our version for:
   - Branding (ClawDad vs NanoClaw)
   - Credential system (support both OneCLI and .env/native proxy)
   - Windows-specific code
   - Features we've added (usage tracking, typing indicators, etc.)
3. Take upstream's version for:
   - Bug fixes in shared logic
   - New patterns/features that don't conflict with our additions
4. Stage resolved files and continue

After all selected commits are applied, create a single commit:
```bash
git commit -m "fix: sync upstream NanoClaw changes (cherry-picked)

Cherry-picked from upstream NanoClaw:
- <list each ported commit's subject and short SHA>

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

If no commits were selected or all were filtered as noise, tell the user:
> Already up to date with upstream — nothing substantive to sync.

## 4. Post-update

Parse what changed since before the update:
```bash
git diff HEAD@{1}..HEAD --stat
```

Note whether `package.json` or `package-lock.json` changed (needs `npm install`).
Note whether anything in `container/` changed (needs container rebuild).

### Install dependencies (if needed)

Only if `package.json` or `package-lock.json` changed:
```bash
npm install
```

### Build

```bash
npm run build
```

If the build fails, show the error and stop. Don't restart the service with a broken build.

### Rebuild container (if needed)

Only if files in `container/` changed:
```bash
./container/build.sh
```

Tell the user this is happening — container builds take a minute or two.

## 5. Restart service

Detect the service label for this instance:
```bash
# The label is com.clawdad.<directory-name>
LABEL="com.clawdad.$(basename $(pwd))"
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

## 6. Verify

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
tail -20 logs/clawdad.error.log
```

## 7. Summary

After a successful update, show a concise summary:

```
Updated ClawDad to <short-hash>.
- Mode: fork / source (cherry-pick)
- Origin: merged / already up to date
- Upstream: <N> commits synced / nothing new / skipped (fork mode)
- <N> files changed
- Dependencies: updated / unchanged
- Container: rebuilt / unchanged
- Service: restarted on port <PORT>
```
