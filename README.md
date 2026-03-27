<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="ClawDad" width="400">
</p>

<p align="center">
  An AI agent orchestrator that runs Claude in isolated containers. Managed via web UI, powered by Claude Code.
</p>

---

## Quick Start

```bash
git clone git@github.com:bd-polaris/bd-nanoclaw.git
cd bd-nanoclaw
claude
```

Then tell Claude: **"Help me get set up"** (or run `/setup`).

Claude handles everything: installing dependencies, configuring Docker, registering your API credentials through the LiteLLM proxy, building the agent container, and starting the web UI.

> **Prerequisite:** [Claude Code](https://claude.com/product/claude-code) must be installed. Everything else is handled by setup.

## What You Get

**Template agents** that run in isolated Docker containers, each with their own workspace:

| Template | What it does |
|----------|-------------|
| **Deployments** | Monitors Harness pipelines, checks security gates, tracks e2e results |
| **Updates** | Pulls Jira activity, drafts weekly status updates, creates retroactive tickets |
| **Bug Triage** | Scans for untriaged bugs, searches for root causes, labels and comments |

**Web dashboard** at `http://localhost:3456`:
- Create agents from templates
- Chat with agents directly
- Review scheduled tasks and execution history
- Monitor container status and telemetry

**Scheduled tasks** — agents can set up recurring jobs (daily check-ins, weekly reports, pipeline monitoring) that run automatically.

## How It Works

```
Web UI  ──>  Orchestrator  ──>  Docker Container (Claude Agent SDK)  ──>  Response
                  │
              SQLite DB
              (messages, tasks, sessions)
```

- **Agents run in Docker containers** with filesystem isolation. Each agent only sees its own workspace.
- **Credentials flow through OneCLI Agent Vault** — a local gateway that intercepts outbound HTTPS and injects API keys at request time. Agents never see raw tokens.
- **The web UI is the primary interface.** No messaging apps required. Chat, create agents, and manage tasks from your browser.
- **Claude Code is the admin tool.** Use it to add templates, tune agent behavior, configure integrations, or debug issues.

## Prerequisites

| Requirement | How to get it |
|-------------|---------------|
| Claude Code | [claude.com/product/claude-code](https://claude.com/product/claude-code) |
| Node.js 20+ | Setup installs this for you |
| Docker | Setup checks and guides installation |
| OneCLI | Setup installs this for you |

The `/setup` skill checks all prerequisites and walks you through fixing anything that's missing.

## Adding Agents

**From the web UI:** Click through the template picker to create a new agent. The agent runs in its own container and walks you through any template-specific configuration in chat.

**Custom agents:** Ask Claude Code to create a new template. Templates live in `templates/` — each is a folder with a `CLAUDE.md` (agent instructions), `meta.json` (name/description), and optionally an `agent-config.json` or helper scripts.

## Credentials

API credentials are managed by [OneCLI Agent Vault](https://github.com/onecli/onecli). The vault runs locally and intercepts outbound HTTPS from containers, injecting credentials per host pattern.

```bash
onecli secrets list                     # See registered credentials
onecli secrets create --name Anthropic \
  --type anthropic \
  --value YOUR_KEY \
  --host-pattern llm.labs.blackduck.com  # Or api.anthropic.com for direct API
```

**LiteLLM proxy:** If your team uses a LiteLLM proxy, set `ANTHROPIC_BASE_URL` in `.env` and use the proxy hostname as the OneCLI `--host-pattern`. Setup guides you through this.

## For Developers

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
npm test             # Run tests
```

Key files: `src/index.ts` (orchestrator), `src/container-runner.ts` (container spawning), `src/channels/web.ts` (web UI + API), `src/health.ts` (prerequisite checks), `templates/` (agent templates).

See [CONTRIBUTING.md](CONTRIBUTING.md) for skill types, PR guidelines, and the contribution model.

## Upstream

bd-nanoclaw is based on [NanoClaw](https://github.com/qwibitai/nanoclaw). To pull upstream updates, use the `/update-nanoclaw` skill.

## License

MIT
