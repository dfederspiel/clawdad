---
name: setup
description: Run initial ClawDad setup. Use when user wants to install dependencies, configure credentials, build the container, or start the web UI. Triggers on "setup", "install", "configure", "help me get set up", or first-time setup requests.
---

# ClawDad Setup

Run setup steps automatically. Only pause when user action is required (pasting a token, making a configuration choice). Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for other steps.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action. If a dependency is missing, install it. If a service won't start, diagnose and repair.

**UX Note:** Use `AskUserQuestion` for multiple-choice questions only (e.g. "Docker or Apple Container?", "which channels?"). Do NOT use it when free-text input is needed (e.g. phone numbers, tokens, paths) -- just ask the question in plain text and wait for the user's reply.

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

- If NODE_OK=false -> Node.js is missing or too old. AskUserQuestion: "Node.js 20+ is required. Want me to install it?" If confirmed:
  - macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`
  - Re-run `bash setup.sh` after install
- If DEPS_OK=false -> Read `logs/setup.log`. Try: delete `node_modules`, re-run `bash setup.sh`.
- If NATIVE_OK=false -> better-sqlite3 build failed. Install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), retry.

## 2. Check Environment

Run `npx tsx setup/index.ts --step environment` and parse the status block.

- If HAS_AUTH=true -> WhatsApp is already configured, note for step 5
- If HAS_REGISTERED_GROUPS=true -> note existing config, offer to skip or reconfigure
- Record APPLE_CONTAINER and DOCKER values for step 3

## 2a. Timezone

Run `npx tsx setup/index.ts --step timezone` and parse the status block.

- If NEEDS_USER_INPUT=true -> The system timezone could not be autodetected (e.g. POSIX-style TZ like `IST-2`). AskUserQuestion: "What is your timezone?" with common options (America/New_York, Europe/London, Asia/Jerusalem, Asia/Tokyo) and an "Other" escape. Then re-run: `npx tsx setup/index.ts --step timezone -- --tz <their-answer>`.
- If STATUS=success -> Timezone is configured. Note RESOLVED_TZ for reference.

## 3. Container Runtime

Choose runtime, install Docker if needed, build and test the agent container image.

Read `${CLAUDE_SKILL_DIR}/references/container-runtime.md` for the full flow (runtime choice logic, Docker install, Apple Container gate, build and test).

## 4. Credential System

Configure Anthropic credentials (subscription/OAuth, direct API key, or LiteLLM proxy). All credentials stored in `.env` and injected by the built-in credential proxy.

First check if already configured:
```bash
grep -E 'ANTHROPIC_(API_KEY|AUTH_TOKEN)' .env 2>/dev/null
```

If not configured, Read `${CLAUDE_SKILL_DIR}/references/credentials.md` for the full credential setup flow (subscription path, direct API path, LiteLLM proxy path, verification).

## 5. Channels, Web UI, Service, and Verification

Set up messaging channels, configure the web UI port, start the service, and verify health.

Read `${CLAUDE_SKILL_DIR}/references/channels-and-service.md` for the full flow covering:
- **Step 5** -- Channel setup (delegate to `/add-whatsapp`, `/add-telegram`, `/add-slack`, `/add-discord`), then rebuild container
- **Step 5b** -- Environment check and web UI port selection
- **Step 6** -- Start as background service or development mode
- **Step 7** -- Health check verification (`/api/health` endpoint)
- **Troubleshooting** -- Service, container, credential, and web UI issues
