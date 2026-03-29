<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="ClawDad" width="400">
</p>

<p align="center">
  A hands-on platform for building and running Claude agents — built on <a href="https://github.com/qwibitai/nanoclaw">NanoClaw</a>.
</p>

---

## What is ClawDad?

Most agent platforms treat you as a consumer — pick a template, click run, hope for the best. ClawDad takes a different approach: it helps you **build intuition for how AI agents work** by making you a participant in their creation.

The web UI at `http://localhost:3456` gives you a local environment to create agents, chat with them, and watch them work — no Slack, WhatsApp, or any other connector required. **Packs** provide guided scenarios that walk you through building agents step by step, teaching you what good instructions look like, how to scope agent capabilities, and when to give an agent more or less autonomy. You're not just filling in a form — you're learning to think in agents.

As you build that intuition, ClawDad grows with you. Advanced users graduate to building agents directly in Claude Code's CLI, where you have full control over instructions, tools, and container configuration. The web UI stays useful as a dashboard for monitoring tasks, reviewing execution history, and chatting with running agents.

Under the hood, ClawDad is built on [NanoClaw](https://github.com/qwibitai/nanoclaw), which handles the hard parts: Docker container isolation, credential injection via OneCLI Agent Vault, and the Claude Agent SDK runtime.

## Quick Start

```bash
git clone git@github.com:bd-polaris/bd-nanoclaw.git
cd bd-nanoclaw
claude
```

Then tell Claude: **"Help me get set up"** (or run `/setup`).

Claude handles everything: installing dependencies, configuring Docker, registering your API credentials, building the agent container, and starting the web UI.

> **Prerequisite:** [Claude Code](https://claude.com/product/claude-code) must be installed. Everything else is handled by setup.

## The Web UI

The dashboard at `http://localhost:3456` serves two roles:

**For learning and creating:**
- **Packs** — guided scenarios that walk you through building agents for specific use cases (ops, triage, reporting). Each pack teaches agent design patterns as you go.
- **Create agents** — build from pack templates or start from scratch. Each agent runs in its own isolated Docker container.

**For day-to-day use:**
- **Chat locally** — talk to your agents right in the browser. No need to set up Slack, WhatsApp, or any other messaging platform.
- **Monitor tasks** — see scheduled jobs, execution history, and container status at a glance.
- **Manage credentials** — register API keys through the UI instead of the CLI.

The web UI uses Preact + HTM with no build step. Edit files in `web/` and refresh the browser.

## How It Works

```
Browser  ──>  Web UI (Preact)  ──>  Orchestrator (Node.js)  ──>  Docker Container (Claude Agent SDK)
                                          │
                                      SQLite DB
                                      (messages, tasks, sessions)
```

- **Agents run in Docker containers** with filesystem isolation. Each agent only sees its own workspace.
- **Credentials flow through OneCLI Agent Vault** — a local gateway that intercepts outbound HTTPS and injects API keys at request time. Agents never see raw tokens.
- **Claude Code is the admin tool.** Use it to add templates, tune agent behavior, configure integrations, or debug issues.

## Prerequisites

| Requirement | How to get it |
|-------------|---------------|
| Claude Code | [claude.com/product/claude-code](https://claude.com/product/claude-code) |
| Node.js 20+ | Setup installs this for you |
| Docker | Setup checks and guides installation |
| OneCLI | Setup installs this for you |

The `/setup` skill checks all prerequisites and walks you through fixing anything that's missing.

## Credentials

API credentials are managed by [OneCLI Agent Vault](https://github.com/onecli/onecli). The vault runs locally and intercepts outbound HTTPS from containers, injecting credentials per host pattern.

```bash
onecli secrets list                     # See registered credentials
onecli secrets create --name Anthropic \
  --type anthropic \
  --value YOUR_KEY \
  --host-pattern api.anthropic.com
```

You can also register credentials through the web UI's credential modal during setup or at any time from the dashboard.

## Extending with Skills

ClawDad inherits NanoClaw's skill system. Add capabilities by merging skill branches:

| Skill | What it adds |
|-------|-------------|
| `/add-whatsapp` | WhatsApp channel |
| `/add-telegram` | Telegram channel |
| `/add-slack` | Slack channel |
| `/add-discord` | Discord channel |
| `/add-voice-transcription` | Voice message transcription |
| `/customize` | Interactive guide for adding integrations |

Run `/setup` for first-time configuration, `/update` to pull latest code and restart, or `/debug` for troubleshooting.

## Development

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
npm test             # Run tests
```

Key paths:
- `src/` — orchestrator (TypeScript)
- `web/` — frontend (Preact + HTM, no build step)
- `container/` — agent container image and runtime skills
- `.claude/skills/` — Claude Code skills (setup, debug, customize, etc.)

See [CONTRIBUTING.md](CONTRIBUTING.md) for skill types, PR guidelines, and the contribution model.

## Upstream

ClawDad is built on [NanoClaw](https://github.com/qwibitai/nanoclaw) by [Qwibit](https://github.com/qwibitai). The core container runtime, agent SDK integration, credential vault, and skill system all come from NanoClaw. Use `/update-nanoclaw` to pull upstream updates.

## License

MIT
