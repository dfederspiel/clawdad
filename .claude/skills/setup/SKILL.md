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
> 2. OneCLI (credential vault)
> 3. Docker (container runtime)
> 4. Your Anthropic API credentials
> 5. The agent container image
> 6. The web UI
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

NanoClaw uses OneCLI to manage credentials. Check if already configured:

### 3c. Build and test

Run `npx tsx setup/index.ts --step container -- --runtime <chosen>` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- Cache issue (stale layers): `docker builder prune -f` (Docker) or `container builder stop && container builder rm && container builder start` (Apple Container). Retry.
- Dockerfile syntax or missing files: diagnose from the log and fix, then retry.

**If TEST_OK=false but BUILD_OK=true:** The image built but won't run. Check logs — common cause is runtime not fully started. Wait a moment and retry the test.

## 4. Credential System

The credential system depends on the container runtime chosen in step 3.

### 4a. Docker → OneCLI

Install OneCLI and its CLI tool:

```bash
curl -fsSL onecli.sh/install | sh
curl -fsSL onecli.sh/cli/install | sh
```

Verify both installed: `onecli version`. If the command is not found, the CLI was likely installed to `~/.local/bin/`. Add it to PATH for the current session and persist it:

```bash
export PATH="$HOME/.local/bin:$PATH"
# Persist for future sessions (append to shell profile if not already present)
grep -q '.local/bin' ~/.bashrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
grep -q '.local/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Then re-verify with `onecli version`.

Point the CLI at the local OneCLI instance (it defaults to the cloud service otherwise):
```bash
onecli config set api-host http://127.0.0.1:10254
```

Ensure `.env` has the OneCLI URL (create the file if it doesn't exist):
```bash
grep -q 'ONECLI_URL' .env 2>/dev/null || echo 'ONECLI_URL=http://127.0.0.1:10254' >> .env
```

Check if a secret already exists:
```bash
onecli secrets list
```

If an Anthropic secret is listed, confirm with user: keep or reconfigure?

AskUserQuestion: How do you connect to Claude?

1. **LiteLLM proxy (recommended)** — description: "Your team runs a LiteLLM proxy that routes to Anthropic. You'll need the proxy URL and an API key."
2. **Direct Anthropic API** — description: "Pay-per-use API key from console.anthropic.com, hitting api.anthropic.com directly."
3. **Claude subscription (Pro/Max)** — description: "Uses your existing Claude Pro or Max subscription via setup-token."

### LiteLLM proxy path

AskUserQuestion: "What's your LiteLLM proxy URL?" with placeholder `https://your-litellm-proxy.example.com`.

Then ask: "What API key should I use for the proxy?" (They can paste it directly — handle gracefully.)

Set `ANTHROPIC_BASE_URL` in `.env`:
```bash
grep -q 'ANTHROPIC_BASE_URL' .env 2>/dev/null && \
  sed -i '' "s|.*ANTHROPIC_BASE_URL.*|ANTHROPIC_BASE_URL=<proxy-url>|" .env || \
  echo "ANTHROPIC_BASE_URL=<proxy-url>" >> .env
```

Extract hostname from the URL for the host pattern. Register with OneCLI:
```bash
onecli secrets create --name Anthropic --type anthropic --value <KEY> --host-pattern <proxy-hostname>
```

**If the user pastes a key starting with `sk-ant-`:** handle it — run the `onecli secrets create` command with that value directly.

### Direct API path

Tell user to get a key from https://console.anthropic.com/settings/keys if they don't have one.

AskUserQuestion with two registration methods:
1. **Dashboard** — "Open http://127.0.0.1:10254 and add the secret in the UI. Type: anthropic."
2. **CLI** — "Run: `onecli secrets create --name Anthropic --type anthropic --value YOUR_KEY --host-pattern api.anthropic.com`"

Make sure `ANTHROPIC_BASE_URL` is NOT set (or commented out) in `.env` for direct API.

#### Subscription path

Tell the user:

> Run `claude setup-token` in another terminal. It will output a token — copy it but don't paste it here.

Then stop and wait for the user to confirm they have the token. Do NOT proceed until they respond.

Once they confirm, they register it with OneCLI. AskUserQuestion with two options:

### After any path

#### API key path

**Verify endpoint match:** If `ANTHROPIC_BASE_URL` is set in `.env`, confirm the OneCLI secret's `hostPattern` matches. If they don't match, warn and offer to fix.

Then AskUserQuestion with two options:

1. **Dashboard** — description: "Best if you have a browser on this machine. Open http://127.0.0.1:10254 and add the secret in the UI."
2. **CLI** — description: "Best for remote/headless servers. Run: `onecli secrets create --name Anthropic --type anthropic --value YOUR_KEY --host-pattern api.anthropic.com`"

#### After either path

Ask them to let you know when done.

**If the user's response happens to contain a token or key** (starts with `sk-ant-`): handle it gracefully — run the `onecli secrets create` command with that value on their behalf.

**After user confirms:** verify with `onecli secrets list` that an Anthropic secret exists. If not, ask again.

### 4b. Apple Container → Native Credential Proxy

Apple Container is not compatible with OneCLI. The credential proxy code is already included in the apple-container branch — do NOT invoke `/use-native-credential-proxy` (it would conflict with already-applied code).

Instead, just configure the credentials in `.env`:

AskUserQuestion: Do you want to use your **Claude subscription** (Pro/Max) or an **Anthropic API key**?

1. **Claude subscription (Pro/Max)** — description: "Uses your existing Claude Pro or Max subscription. Run `claude setup-token` in another terminal to get your token."
2. **Anthropic API key** — description: "Pay-per-use API key from console.anthropic.com."

For subscription: tell the user to run `claude setup-token` in another terminal. Stop and wait for the user to confirm they have completed this step successfully before proceeding.

Once confirmed, add the token to `.env`:
```bash
echo 'CLAUDE_CODE_OAUTH_TOKEN=<their-token>' >> .env
```

For API key: add to `.env`:
```bash
echo 'ANTHROPIC_API_KEY=<their-key>' >> .env
```

Verify the proxy starts: `npm run dev` should show "Credential proxy listening" in the logs.

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
- CREDENTIALS=missing → re-run step 4 (Docker: check `onecli secrets list`; Apple Container: check `.env` for credentials)
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
- `onecli.status` = "running"
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

**Service not starting:** Check `logs/nanoclaw.error.log`. Common: wrong Node path (re-run step 7), credential system not running (Docker: check `curl http://127.0.0.1:10254/api/health`; Apple Container: check `.env` credentials), missing channel credentials (re-invoke channel skill).

**Container agent fails:** Ensure Docker is running. Check container logs in `groups/*/logs/container-*.log`.

**"Invalid API key" errors:** `ANTHROPIC_BASE_URL` in `.env` and OneCLI `hostPattern` must match the same host. Run `onecli secrets list` to check.

**Web UI won't load:** Ensure `WEB_UI_ENABLED=true` in `.env`. Check port conflicts: `lsof -i :3456`.
