---
name: setup
description: Run initial ClawDad setup. Use when user wants to install dependencies, configure credentials, build the container, or start the web UI. Triggers on "setup", "install", "configure", "help me get set up", or first-time setup requests.
---

# ClawDad Setup

Run setup steps automatically. Only pause when user action is required (pasting a token, making a configuration choice). Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for other steps.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action. If a dependency is missing, install it. If a service won't start, diagnose and repair.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

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

## 1. Bootstrap (Node.js + Dependencies + OneCLI)

Run `bash setup.sh` and parse the status block.

- If NODE_OK=false → Node.js is missing or too old. AskUserQuestion: "Node.js 20+ is required. Want me to install it?" If confirmed:
  - macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`
  - Re-run `bash setup.sh` after install
- If DEPS_OK=false → Read `logs/setup.log`. Try: delete `node_modules`, re-run `bash setup.sh`.
- If NATIVE_OK=false → better-sqlite3 build failed. Install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), retry.

After bootstrap succeeds, install OneCLI:

```bash
curl -fsSL onecli.sh/install | sh
curl -fsSL onecli.sh/cli/install | sh
```

Verify: `onecli version`. If not found, add `~/.local/bin` to PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
grep -q '.local/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
grep -q '.local/bin' ~/.bashrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

Point CLI at local instance:
```bash
onecli config set api-host http://127.0.0.1:10254
```

Install the Node.js SDK so the runtime can talk to the gateway:
```bash
npm ls @onecli-sh/sdk 2>/dev/null || npm install @onecli-sh/sdk
```

Ensure `.env` has OneCLI URL:
```bash
grep -q 'ONECLI_URL' .env 2>/dev/null || echo 'ONECLI_URL=http://127.0.0.1:10254' >> .env
```

## 2. Docker

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

### Subscription path

Tell user to run `claude setup-token` in another terminal and copy the token.

Register the same way as direct API, with `--host-pattern api.anthropic.com`.

### After any path

Verify: `onecli secrets list` should show an Anthropic secret.

**Verify endpoint match:** If `ANTHROPIC_BASE_URL` is set in `.env`, confirm the OneCLI secret's `hostPattern` matches. If they don't match, warn and offer to fix.

## 4. Container Image

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

Run `npx tsx setup/index.ts --step timezone`. If NEEDS_USER_INPUT=true, AskUserQuestion for timezone.

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

**Service not starting:** Check `logs/nanoclaw.error.log`. Common: wrong Node path (re-run step 6), OneCLI not running (`curl http://127.0.0.1:10254/api/health`).

**Container agent fails:** Ensure Docker is running. Check container logs in `groups/*/logs/container-*.log`.

**"Invalid API key" errors:** `ANTHROPIC_BASE_URL` in `.env` and OneCLI `hostPattern` must match the same host. Run `onecli secrets list` to check.

**Web UI won't load:** Ensure `WEB_UI_ENABLED=true` in `.env`. Check port conflicts: `lsof -i :3456`.
