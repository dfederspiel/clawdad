---
name: x-integration
description: X (Twitter) integration for NanoClaw. Post tweets, like, reply, retweet, and quote. Use for setup, testing, or troubleshooting X functionality. Triggers on "setup x", "x integration", "twitter", "post tweet", "tweet".
---

# X (Twitter) Integration

Browser automation for X interactions via WhatsApp.

> **Compatibility:** NanoClaw v1.0.0. Directory structure may change in future versions.

## Features

| Action | Tool | Description |
|--------|------|-------------|
| Post | `x_post` | Publish new tweets |
| Like | `x_like` | Like any tweet |
| Reply | `x_reply` | Reply to tweets |
| Retweet | `x_retweet` | Retweet without comment |
| Quote | `x_quote` | Quote tweet with comment |

## Prerequisites

Before using this skill, ensure:

1. **NanoClaw is installed and running** - WhatsApp connected, service active
2. **Dependencies installed**:
   ```bash
   npm ls playwright dotenv-cli || npm install playwright dotenv-cli
   ```
3. **CHROME_PATH configured** in `.env` (if Chrome is not at default location):
   ```bash
   # Find your Chrome path
   mdfind "kMDItemCFBundleIdentifier == 'com.google.Chrome'" 2>/dev/null | head -1
   # Add to .env
   CHROME_PATH=/path/to/Google Chrome.app/Contents/MacOS/Google Chrome
   ```

## Quick Start

```bash
# 1. Setup authentication (interactive)
npx dotenv -e .env -- npx tsx .claude/skills/x-integration/scripts/setup.ts
# Verify: data/x-auth.json should exist after successful login

# 2. Rebuild container to include skill
./container/build.sh
# Verify: Output shows "COPY .claude/skills/x-integration/agent.ts"

# 3. Rebuild host and restart service
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CHROME_PATH` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` | Chrome executable path |
| `NANOCLAW_ROOT` | `process.cwd()` | Project root directory |
| `LOG_LEVEL` | `info` | Logging level (debug, info, warn, error) |

Set in `.env` file (loaded via `dotenv-cli` at runtime).

## Configuration File

Edit `lib/config.ts` to modify viewport, timeouts, and tweet limits. Defaults: 1280x800 viewport, 30s navigation timeout, 280 char tweet limit.

## Data Directories

| Path | Purpose | Git |
|------|---------|-----|
| `data/x-browser-profile/` | Chrome profile with X session | Ignored |
| `data/x-auth.json` | Auth state marker | Ignored |
| `logs/nanoclaw.log` | Service logs (contains X operation logs) | Ignored |

## Usage via WhatsApp

Replace `@Assistant` with your configured trigger name (`ASSISTANT_NAME` in `.env`):

```
@Assistant post a tweet: Hello world!
@Assistant like this tweet https://x.com/user/status/123
@Assistant reply to https://x.com/user/status/123 with: Great post!
@Assistant retweet https://x.com/user/status/123
@Assistant quote https://x.com/user/status/123 with comment: Interesting
```

**Note:** Only the main group can use X tools. Other groups will receive an error.

## References

For implementation details, read these files as needed:

- **Architecture and file structure:** Read `${CLAUDE_SKILL_DIR}/references/architecture.md`
- **Integration points** (host IPC, container MCP, build script, Dockerfile changes): Read `${CLAUDE_SKILL_DIR}/references/integration-points.md`
- **Detailed setup and testing:** Read `${CLAUDE_SKILL_DIR}/references/setup-and-testing.md`
- **Troubleshooting** (auth, locks, logs, selectors, container build, security): Read `${CLAUDE_SKILL_DIR}/references/troubleshooting.md`
