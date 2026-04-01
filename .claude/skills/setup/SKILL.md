---
name: setup
description: Run initial ClawDad setup. Use when user wants to install dependencies, configure credentials, build the container, or start the web UI. Triggers on "setup", "install", "configure", "help me get set up", or first-time setup requests.
---

# ClawDad Setup

Run setup steps automatically. Only pause when user action is required (pasting a token, making a configuration choice). Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for other steps.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action. If a dependency is missing, install it. If a service won't start, diagnose and repair.

**UX Note:** Use `AskUserQuestion` for multiple-choice questions only (e.g. "Docker or Apple Container?", "which channels?"). Do NOT use it when free-text input is needed (e.g. phone numbers, tokens, paths) — just ask the question in plain text and wait for the user's reply.

## 0. Orientation

Welcome the user briefly. Explain what will happen:

> I'll walk you through getting ClawDad running. This sets up:
> 1. Node.js dependencies
> 2. Docker (container runtime)
> 3. Your Anthropic API credentials (stored in .env, injected by the credential proxy)
> 4. The agent container image
> 5. The web UI
>
> Most steps are automatic. I'll ask when I need your input.

## 1. Bootstrap (Node.js + Dependencies)

Run `bash setup.sh` and parse the status block.

- If NODE_OK=false → Node.js is missing or too old. AskUserQuestion: "Node.js 20+ is required. Want me to install it?" If confirmed:
  - macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`
  - Re-run `bash setup.sh` after install
- If DEPS_OK=false → Read `logs/setup.log`. Try: delete `node_modules`, re-run `bash setup.sh`.
- If NATIVE_OK=false → better-sqlite3 build failed. Install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), retry.

## 2. Check Environment

Run `npx tsx setup/index.ts --step environment` and parse the status block.

- If HAS_AUTH=true → WhatsApp is already configured, note for step 5
- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record APPLE_CONTAINER and DOCKER values for step 3

## 2a. Timezone

Run `npx tsx setup/index.ts --step timezone` and parse the status block.

- If NEEDS_USER_INPUT=true → The system timezone could not be autodetected (e.g. POSIX-style TZ like `IST-2`). AskUserQuestion: "What is your timezone?" with common options (America/New_York, Europe/London, Asia/Jerusalem, Asia/Tokyo) and an "Other" escape. Then re-run: `npx tsx setup/index.ts --step timezone -- --tz <their-answer>`.
- If STATUS=success → Timezone is configured. Note RESOLVED_TZ for reference.

## 3. Container Runtime

### 3a. Choose runtime

Check the preflight results for `APPLE_CONTAINER` and `DOCKER`, and the PLATFORM from step 1.

- PLATFORM=linux → Docker (only option)
- PLATFORM=macos + APPLE_CONTAINER=installed → AskUserQuestion with two options:
  1. **Docker (recommended)** — description: "Cross-platform, better credential management, well-tested."
  2. **Apple Container (experimental)** — description: "Native macOS runtime. Requires advanced setup."
  If Apple Container, run `/convert-to-apple-container` now, then skip to 3c.
- PLATFORM=macos + APPLE_CONTAINER=not_found → Docker

### 3a-docker. Install Docker

- DOCKER=running → continue to 4b
- DOCKER=installed_not_running → start Docker: `open -a Docker` (macOS) or `sudo systemctl start docker` (Linux). Wait 15s, re-check with `docker info`.
- DOCKER=not_found → Use `AskUserQuestion: Docker is required for running agents. Would you like me to install it?` If confirmed:
  - macOS: install via `brew install --cask docker`, then `open -a Docker` and wait for it to start. If brew not available, direct to Docker Desktop download at https://docker.com/products/docker-desktop
  - Linux: install with `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`. Note: user may need to log out/in for group membership.

### 3b. Apple Container conversion gate (if needed)

**If the chosen runtime is Apple Container**, you MUST check whether the source code has already been converted from Docker to Apple Container. Do NOT skip this step. Run:

Check if Docker is available:
```bash
docker info 2>/dev/null && echo "DOCKER_RUNNING" || (which docker 2>/dev/null && echo "DOCKER_INSTALLED" || echo "DOCKER_MISSING")
```

- **DOCKER_RUNNING** → continue to step 3
- **DOCKER_INSTALLED** → start it: `open -a Docker` (macOS) or `sudo systemctl start docker` (Linux). Wait 15s, re-check.
- **DOCKER_MISSING** → AskUserQuestion: "Docker is required for running agents. Want me to install it?"
  - macOS: `brew install --cask docker` then `open -a Docker`
  - Linux: `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`
  - Note: Linux users may need to log out/in for docker group

## 3. Anthropic Credentials

ClawDad uses a built-in credential proxy that reads from `.env`. Check if already configured:

```bash
grep -E 'ANTHROPIC_(API_KEY|AUTH_TOKEN)' .env 2>/dev/null
```

### 3c. Build and test

Run `npx tsx setup/index.ts --step container -- --runtime <chosen>` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- Cache issue (stale layers): `docker builder prune -f` (Docker) or `container builder stop && container builder rm && container builder start` (Apple Container). Retry.
- Dockerfile syntax or missing files: diagnose from the log and fix, then retry.

**If TEST_OK=false but BUILD_OK=true:** The image built but won't run. Check logs — common cause is runtime not fully started. Wait a moment and retry the test.

## 4. Credential System

All credentials are stored in `.env` and injected by the built-in credential proxy. The proxy auto-detects the auth mode based on which variable is set.

AskUserQuestion: How do you connect to Claude?

1. **Claude subscription (Pro/Max)** — description: "Uses your existing Claude Pro or Max subscription via setup-token."
2. **Direct Anthropic API** — description: "Pay-per-use API key from console.anthropic.com."
3. **LiteLLM proxy** — description: "Your team runs a LiteLLM proxy that routes to Anthropic. You'll need the proxy URL and an API key."

### Subscription path (OAuth token)

Tell the user:

> Run `claude setup-token` in another terminal and complete the authentication flow.

Then stop and wait for the user to confirm they've completed it. Do NOT proceed until they respond.

Once confirmed, copy the token from Claude Code's credential store and save to `.env`:

```bash
# Extract token from Claude Code credentials
TOKEN=$(python -c "import json; d=json.load(open('$HOME/.claude/.credentials.json')); print(d['claudeAiOauth']['accessToken'])")
# On Windows with Git Bash, use the Windows-style home path if needed:
# TOKEN=$(python -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/.credentials.json'))); print(d['claudeAiOauth']['accessToken'])")

# Save as ANTHROPIC_AUTH_TOKEN (NOT ANTHROPIC_API_KEY — OAuth tokens require Bearer auth)
grep -q 'ANTHROPIC_AUTH_TOKEN' .env 2>/dev/null && \
  sed -i "s|.*ANTHROPIC_AUTH_TOKEN.*|ANTHROPIC_AUTH_TOKEN=$TOKEN|" .env || \
  echo "ANTHROPIC_AUTH_TOKEN=$TOKEN" >> .env
```

**Important:** OAuth tokens (`sk-ant-oat01-...`) must use `ANTHROPIC_AUTH_TOKEN`. Setting them as `ANTHROPIC_API_KEY` will fail with "Invalid API key" because the proxy sends them as `x-api-key` instead of `Authorization: Bearer`.

### Direct API path

Tell user to get a key from https://console.anthropic.com/settings/keys if they don't have one.

**If the user pastes a key starting with `sk-ant-api03-`:** save it directly to `.env`.

```bash
grep -q 'ANTHROPIC_API_KEY' .env 2>/dev/null && \
  sed -i "s|.*ANTHROPIC_API_KEY.*|ANTHROPIC_API_KEY=<KEY>|" .env || \
  echo "ANTHROPIC_API_KEY=<KEY>" >> .env
```

Make sure `ANTHROPIC_BASE_URL` is NOT set (or commented out) in `.env` for direct API.

### LiteLLM proxy path

AskUserQuestion: "What's your LiteLLM proxy URL?" with placeholder `https://your-litellm-proxy.example.com`.

Then ask: "What API key should I use for the proxy?" (They can paste it directly — handle gracefully.)

Set both in `.env`:
```bash
grep -q 'ANTHROPIC_BASE_URL' .env 2>/dev/null && \
  sed -i "s|.*ANTHROPIC_BASE_URL.*|ANTHROPIC_BASE_URL=<proxy-url>|" .env || \
  echo "ANTHROPIC_BASE_URL=<proxy-url>" >> .env

grep -q 'ANTHROPIC_API_KEY' .env 2>/dev/null && \
  sed -i "s|.*ANTHROPIC_API_KEY.*|ANTHROPIC_API_KEY=<KEY>|" .env || \
  echo "ANTHROPIC_API_KEY=<KEY>" >> .env
```

### After any path

Verify credentials are configured:
```bash
grep -E 'ANTHROPIC_(API_KEY|AUTH_TOKEN)' .env
```

If neither is found, ask the user to try again.

## 5. Set Up Channels

AskUserQuestion (multiSelect): Which messaging channels do you want to enable?
- WhatsApp (authenticates via QR code or pairing code)
- Telegram (authenticates via bot token from @BotFather)
- Slack (authenticates via Slack app with Socket Mode)
- Discord (authenticates via Discord bot token)

**Delegate to each selected channel's own skill.** Each channel skill handles its own code installation, authentication, registration, and JID resolution. This avoids duplicating channel-specific logic and ensures JIDs are always correct.

For each selected channel, invoke its skill:

- **WhatsApp:** Invoke `/add-whatsapp`
- **Telegram:** Invoke `/add-telegram`
- **Slack:** Invoke `/add-slack`
- **Discord:** Invoke `/add-discord`

Each skill will:
1. Install the channel code (via `git merge` of the skill branch)
2. Collect credentials/tokens and write to `.env`
3. Authenticate (WhatsApp QR/pairing, or verify token-based connection)
4. Register the chat with the correct JID format
5. Build and verify

**After all channel skills complete**, install dependencies and rebuild — channel merges may introduce new packages:

Build the agent container:
```bash
./container/build.sh
```

If it fails:
- Cache issue: `docker builder prune -f` then retry
- Missing files: diagnose from output and fix

Verify:
```bash
docker images nanoclaw-agent:latest --format '{{.ID}}'
```

## 5. Environment Check

Run `npx tsx setup/index.ts --step environment` and parse the status block.

### Timezone

**If STATUS=failed, fix each:**
- SERVICE=stopped → `npm run build`, then restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux) or `bash start-nanoclaw.sh` (WSL nohup)
- SERVICE=not_found → re-run step 7
- CREDENTIALS=missing → re-run step 4 (check `.env` for `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`)
- CHANNEL_AUTH shows `not_found` for any channel → re-invoke that channel's skill (e.g. `/add-telegram`)
- REGISTERED_GROUPS=0 → re-invoke the channel skills from step 5
- MOUNT_ALLOWLIST=missing → `npx tsx setup/index.ts --step mounts -- --empty`

### Web UI & Port Selection

Ensure `.env` has web UI enabled:
```bash
grep -q 'WEB_UI_ENABLED=true' .env || echo 'WEB_UI_ENABLED=true' >> .env
```

**Always check for other running ClawDad/NanoClaw instances before assigning a port.** Scan the default port range to detect existing instances and pick the next free port:

```bash
# Find all nanoclaw processes and their ports
OTHER_PORTS=$(lsof -iTCP -sTCP:LISTEN -P 2>/dev/null | grep node | grep -oE ':(345[0-9]|346[0-9])' | tr -d ':' | sort -u)
echo "Ports in use by other instances: ${OTHER_PORTS:-none}"

# Check candidate ports starting at 3456
for PORT in 3456 3457 3458 3459 3460; do
  lsof -i :$PORT >/dev/null 2>&1 || { echo "FREE_PORT=$PORT"; break; }
done
```

- **If 3456 is free and no other instances detected:** Use 3456 (the default). Set in `.env`:
  ```bash
  grep -q 'WEB_UI_PORT' .env || echo 'WEB_UI_PORT=3456' >> .env
  ```

- **If other instances are detected:** Tell the user what you found, e.g. "I found another ClawDad instance running on port 3456." Then AskUserQuestion: "I'll use port <FREE_PORT> for this instance. Sound good?"
  - **Yes (recommended)** — description: "Use port <FREE_PORT>. You'll access this instance at http://localhost:<FREE_PORT>."
  - **Different port** — description: "Choose a custom port number."

  Update `.env` with the chosen port:
  ```bash
  grep -q 'WEB_UI_PORT' .env && sed -i '' "s/WEB_UI_PORT=.*/WEB_UI_PORT=<PORT>/" .env || echo "WEB_UI_PORT=<PORT>" >> .env
  ```

Tell the user their web UI URL so they know which instance is which: "This instance will run at http://localhost:<PORT>".

## 6. Start

AskUserQuestion: How do you want to run ClawDad?

1. **Background service (recommended)** — description: "Registers as a system service that starts on boot. Best for always-on operation."
2. **Development mode** — description: "Runs in the foreground with hot reload. Best for making code changes."

### Background service

Run `npx tsx setup/index.ts --step service` and parse status block.

- macOS: uses launchd (`~/Library/LaunchAgents/com.nanoclaw.plist`)
- Linux: uses systemd (`~/.config/systemd/user/nanoclaw.service`)

Handle errors per the diagnostics in the service step output.

Tell user: "ClawDad is running as a background service. Open http://localhost:PORT in your browser."

### Development mode

```bash
npm run build && npm run start
```

Tell user: "ClawDad is running. Open http://localhost:PORT in your browser."

## 7. Verify

Open the health check endpoint to confirm everything is green:

```bash
curl -s http://localhost:3456/api/health | python3 -m json.tool
```

Check that:
- `docker.status` = "running"
- `credential_proxy.status` = "configured"
- `anthropic.status` = "configured"
- `container_image.status` = "built"
- `overall` = "ready"

If anything is not green, go back to the relevant step and fix it.

Tell the user:

> Setup complete! Open http://localhost:3456 to access the web UI.
>
> From here you can:
> - **Create agents** from templates (deployments, updates, bug triage)
> - **Chat with agents** directly in the browser
> - **Review scheduled tasks** and their execution history
>
> To add more complex agents or customize behavior, run `claude` and describe what you want.

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common: wrong Node path (re-run step 7), missing credentials in `.env` (re-run step 4), missing channel credentials (re-invoke channel skill).

**Container agent fails:** Ensure Docker is running. Check container logs in `groups/*/logs/container-*.log`.

**"Invalid API key" errors:** If using an OAuth token (`sk-ant-oat01-`), it must be set as `ANTHROPIC_AUTH_TOKEN`, not `ANTHROPIC_API_KEY`. If using a custom endpoint, ensure `ANTHROPIC_BASE_URL` in `.env` is correct.

**Web UI won't load:** Ensure `WEB_UI_ENABLED=true` in `.env`. Check port conflicts: `lsof -i :3456`.
