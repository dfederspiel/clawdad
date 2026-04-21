<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="ClawDad" width="400">
</p>

<p align="center">
  A container-native platform for building, running, and observing local AI agent teams.
</p>

---

## What is ClawDad?

ClawDad is a **local agent orchestration platform** that runs AI agents in isolated Docker containers on your machine. You create agents, give them instructions and access to your repos, and chat with them through a web UI at `http://localhost:3456`.

Agents run with full container isolation — they can read your code, make changes, and use tools, but they never see your raw credentials and can only access directories you explicitly allow.

It started as a fork of [NanoClaw](https://github.com/qwibitai/nanoclaw) and has evolved into its own platform with multi-agent coordination, delegation, observability, and a guided onboarding experience.

See [docs/what-is-clawdad.md](docs/what-is-clawdad.md) for the full product statement.

## Quick Start

```bash
git clone git@github.com:dfederspiel/clawdad.git
cd clawdad
claude
```

Then tell Claude: **"Help me get set up"** (or run `/setup`).

Setup walks you through:

1. **Bootstrap** — installs Node.js 20+ and npm dependencies
2. **Container runtime** — installs Docker (or Apple Containers on macOS), builds the agent image
3. **Credentials** — configures your Anthropic API key, OAuth token, or LiteLLM proxy endpoint
4. **Channels** — optionally adds WhatsApp, Telegram, Slack, or Discord
5. **Service** — starts ClawDad as a background service (launchd on macOS, systemd on Linux)
6. **Health check** — verifies `http://localhost:3456/api/health` responds

After setup, open `http://localhost:3456` in your browser to start chatting with agents.

> **Prerequisite:** [Claude Code](https://claude.com/product/claude-code) must be installed. Everything else is handled by setup.

## Prerequisites

| Requirement | How to get it |
|-------------|---------------|
| Claude Code | [claude.com/product/claude-code](https://claude.com/product/claude-code) |
| Node.js 20+ | Setup installs this for you |
| Docker | Setup checks and guides installation |

## Configuration

All configuration lives in `.env` at the project root. Setup creates this file for you, but here are the key variables you may need to adjust.

### Model Selection

By default, agents use the Anthropic API directly. If you're routing through a **LiteLLM proxy** or similar gateway, set the model explicitly:

```bash
CLAUDE_MODEL=vertex_ai/claude-opus-4-6
```

Without this, you may see errors like:

```
API Error: 400 "No fallback model group found for original model_group=claude-sonnet-4-6"
```

This happens because the proxy doesn't recognize the default model name. Setting `CLAUDE_MODEL` to your proxy's model identifier fixes it.

### Anthropic Authentication

Two auth modes, auto-detected from `.env`:

| Mode | Variable | When to use |
|------|----------|-------------|
| API Key | `ANTHROPIC_API_KEY=sk-ant-api03-...` | Direct API keys from console.anthropic.com |
| OAuth | `ANTHROPIC_AUTH_TOKEN=sk-ant-oat01-...` | OAuth tokens from `claude setup-token` |

**Common mistake:** OAuth tokens (`sk-ant-oat01-...`) set as `ANTHROPIC_API_KEY` will fail with "Invalid API key". Use `ANTHROPIC_AUTH_TOKEN` for OAuth tokens.

### Custom Endpoint

If using a proxy or custom deployment:

```bash
ANTHROPIC_BASE_URL=https://your-proxy.example.com
```

### Restarting After Changes

Changes to `.env` require a restart. The fastest way:

```bash
# In Claude Code:
/restart

# Or manually on macOS:
kill $(pgrep -f 'node dist/index.js')  # launchd auto-restarts
```

## The Web UI

The dashboard at `http://localhost:3456` is where you create agents and chat with them.

**First time:** You'll see the **General** channel (your admin agent) and any template groups. The General channel has visibility across all agents and is where you manage cross-cutting concerns like credentials and integrations.

**Creating agents:** Click "New Agent" to create from a pack template or start from scratch. Each agent runs in its own Docker container with isolated filesystem.

**Day-to-day:**
- Chat with agents directly in the browser
- Monitor scheduled tasks and execution history
- View per-message cost and token usage (click the usage footer to expand tool history)
- Register credentials through the secure modal (agents never see raw tokens)

The web UI uses Preact + HTM with no build step. Edit files in `web/` and refresh the browser.

## Core Concepts

### Groups

A **group** is a directory under `groups/` that contains one or more agents sharing a workspace. Each group has:

```
groups/web_my-team/
  CLAUDE.md              # Instructions and memory for the group
  group-config.json      # Container config, mounts, automation rules
```

Groups created through the web UI are prefixed with `web_`. The `main/` group is the admin agent with elevated privileges. The `global/` directory contains shared memory readable by all groups.

### Container Isolation

Each agent runs in a Docker container with controlled filesystem access:

| Mount | Path in Container | Access |
|-------|------------------|--------|
| Group folder | `/workspace/group` | Read-write |
| Global memory | `/workspace/global` | Read-only (except main) |
| Additional mounts | `/workspace/extra/{name}` | Configurable |
| IPC | `/workspace/ipc` | Internal |

Agents **never** see your `.env` file, SSH keys, or cloud credentials directly. All authenticated requests flow through the credential proxy on the host.

## Multi-Agent Teams

Groups can contain multiple agents that coordinate via delegation. This is useful for complex workflows where different agents have different specialties.

### Architecture

- **Coordinator** (no trigger) — handles untriggered messages and delegates to specialists. Every multi-agent group should have exactly one.
- **Specialists** (with trigger, e.g. `@analyst`) — respond when @-mentioned by users or delegated to by the coordinator.

### Folder Structure

```
groups/web_my-team/
  CLAUDE.md              # Group-level context (team charter)
  agents/
    coordinator/
      CLAUDE.md          # Coordinator identity and delegation rules
      agent.json         # { "displayName": "Coordinator" }
    analyst/
      CLAUDE.md          # Specialist identity and tools
      agent.json         # { "displayName": "Analyst", "trigger": "@analyst" }
```

### How It Works

1. User messages route to agents by `@mention` trigger matching
2. Untriggered messages go to the coordinator
3. The coordinator delegates to specialists via the `delegate_to_agent` tool
4. Delegations run **in parallel** — specialists spawn concurrently
5. When all delegations complete, the coordinator is re-triggered to synthesize results

### Creating Teams

- **Web UI:** "New Agent" > "Create team" — builds a coordinator + specialist list
- **API:** `POST /api/teams` with `{ name, folder, coordinator, specialists[] }`
- **Filesystem:** Create `agents/` subdirectories with `CLAUDE.md` + `agent.json` as shown above

A group with no `agents/` directory behaves as a single-agent group (backward compatible).

## Giving Agents Access to Local Repos

By default, agents can only see their own group folder. To let an agent work with your code repositories, you need two things: a **mount allowlist** (what directories are allowed) and **mount declarations** in the group config (which directories this agent gets).

### Step 1: Set Up the Mount Allowlist

Create `~/.config/nanoclaw/mount-allowlist.json`:

```json
{
  "allowedRoots": [
    {
      "path": "~/code",
      "allowReadWrite": true,
      "description": "Development repos"
    }
  ],
  "blockedPatterns": [
    ".ssh", ".gnupg", ".env", "credentials", "id_rsa"
  ]
}
```

This allows any directory under `~/code` to be mounted. Sensitive paths (`.ssh`, `.env`, etc.) are always blocked.

### Step 2: Add Mounts to the Group Config

Edit `groups/web_my-team/group-config.json`:

```json
{
  "containerConfig": {
    "additionalMounts": [
      {
        "hostPath": "~/code/polaris-ui",
        "containerPath": "polaris-ui",
        "readonly": false
      },
      {
        "hostPath": "~/code/polaris-react-composition",
        "containerPath": "polaris-react-composition",
        "readonly": false
      }
    ],
    "sshAgent": true
  }
}
```

Inside the container, these appear at `/workspace/extra/polaris-ui` and `/workspace/extra/polaris-react-composition`.

Setting `sshAgent: true` forwards your SSH agent so the agent can clone and push via SSH without private keys entering the container.

### Best Practices

- **Use git worktrees.** Tell your agent in its CLAUDE.md to never work directly on your checked-out branch. Have it create worktrees instead — this prevents it from accidentally working on stale branches or conflicting with your own work.
- **Start read-only.** Set `"readonly": true` until you're confident in the agent's behavior, then switch to read-write.
- **Examine changes in your editor.** The web UI is great for chatting, but when an agent makes code changes, review them in VSCode or your preferred editor. Your editor window keeps getting smaller, but it's still the best tool for reviewing diffs.

## Credentials and Integrations

### How the Credential Proxy Works

ClawDad runs a local credential proxy that sits between agent containers and external services. Agents send requests with placeholder tokens (`__CRED_GITHUB_TOKEN__`), and the proxy substitutes real values from `.env` before forwarding. This means:

- Agents never see your raw API keys or tokens
- Credentials are never in chat history where the LLM could leak them
- New credentials are available immediately after adding to `.env` — no container restart needed (host restart is needed)

### Adding Service Credentials

For services like GitHub, Atlassian, GitLab, etc.:

**Option 1 — Through the Web UI (recommended):**

Ask in the General channel: *"Help me set up access to Atlassian"*. The agent walks you through it and opens a secure modal where you paste your token. The modal writes directly to `.env` — the agent never sees the raw value.

For Atlassian specifically, you'll need:
1. A [Personal Access Token (PAT)](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Your Atlassian email address

**Option 2 — Manually in `.env`:**

```bash
echo 'GITHUB_TOKEN=ghp_xxxxx' >> .env
echo 'ATLASSIAN_API_TOKEN=your-pat-here' >> .env
echo 'ATLASSIAN_EMAIL=you@company.com' >> .env
```

Any variable matching `*_TOKEN`, `*_KEY`, `*_SECRET`, or `*_PASSWORD` is automatically available to the credential proxy (excluding `ANTHROPIC_*` and `CLAUDE_CODE_*` which use the dedicated auth path).

See [docs/CREDENTIALS.md](docs/CREDENTIALS.md) for the full credential system documentation.

## How It Works

```
Browser  ──>  Web UI (Preact)  ──>  Orchestrator (Node.js)  ──>  Docker Container (Claude Agent SDK)
                                          │
                                    Credential Proxy
                                          │
                                      SQLite DB
                                    (messages, tasks, sessions)
```

- **Agents run in Docker containers** with filesystem isolation. Each agent only sees its own workspace plus explicitly mounted directories.
- **Credentials flow through a local proxy** — reads from `.env` and injects API keys into outbound requests. Agents never see raw tokens.
- **Claude Code is the admin tool.** Use it to add templates, tune agent behavior, configure integrations, or debug issues.

## Skills and Extensions

Add capabilities by running skills in Claude Code:

| Skill | What it adds |
|-------|-------------|
| `/setup` | First-time installation and configuration |
| `/update` | Pull latest code, rebuild, and restart |
| `/restart` | Rebuild and restart (no git pull) |
| `/debug` | Troubleshoot container and runtime issues |
| `/customize` | Interactive guide for adding integrations |
| `/add-whatsapp` | WhatsApp channel |
| `/add-telegram` | Telegram channel |
| `/add-slack` | Slack channel |
| `/add-discord` | Discord channel |
| `/add-voice-transcription` | Voice message transcription |

## Development

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
npm test             # Run tests
```

Key paths:

| Path | Purpose |
|------|---------|
| `src/` | Orchestrator (TypeScript) |
| `web/` | Frontend (Preact + HTM, no build step) |
| `container/` | Agent container image and runtime |
| `groups/` | Agent groups, configs, and memory |
| `.claude/skills/` | Claude Code skills (setup, debug, etc.) |
| `docs/` | Design docs and detailed references |

See [CONTRIBUTING.md](CONTRIBUTING.md) for skill types, PR guidelines, and the contribution model.

## Platform Notes

### macOS (default)

ClawDad installs as a **launchd** service (`com.clawdad.clawdad`):

```bash
# Restart
launchctl kickstart -k gui/$(id -u)/com.clawdad.clawdad

# If kickstart doesn't change the PID:
kill $(pgrep -f 'node dist/index.js')  # launchd auto-restarts

# View logs
tail -f logs/clawdad.log
```

### Linux

ClawDad installs as a **systemd** user service:

```bash
systemctl --user start com-nanoclaw-clawdad.service
systemctl --user stop com-nanoclaw-clawdad.service
systemctl --user restart com-nanoclaw-clawdad.service
```

### Windows

ClawDad runs on Windows via **Git Bash**. Known setup requirements:

**Docker Desktop PATH:** After installing Docker Desktop via `winget`, add it to your Git Bash PATH:

```bash
echo 'export PATH="/c/Program Files/Docker/Docker/resources/bin:$PATH"' >> ~/.bashrc
```

Restart your shell after adding this.

**Auto-start:** Both instances (Windows web UI + WSL services) start on login via `scripts/start-clawdad.bat` (installed to the Startup folder during setup).

**Verify after reboot:**

```bash
curl -sf http://localhost:3456/api/health          # Windows web UI
wsl -d Ubuntu -e bash -ic "systemctl --user status com-nanoclaw-clawdad.service"  # WSL
```

## Troubleshooting

### "No fallback model group found" (400 error)

You're using a LiteLLM proxy or similar gateway that doesn't recognize the default model name. Set the model explicitly in `.env`:

```bash
CLAUDE_MODEL=vertex_ai/claude-opus-4-6
```

Then restart: `/restart` in Claude Code or `kill $(pgrep -f 'node dist/index.js')`.

### Container won't start

Run `/debug` in Claude Code for interactive troubleshooting. Common causes:

- Docker not running — start Docker Desktop
- Stale container image — rebuild with `./container/build.sh`
- Port conflict — check if something else is on port 3456

### Credentials not working

1. Check `.env` has the right variable names (see [Configuration](#configuration))
2. Restart ClawDad — the credential proxy reads `.env` at startup
3. For OAuth tokens: use `ANTHROPIC_AUTH_TOKEN`, not `ANTHROPIC_API_KEY`

### Container exit 137 (SIGKILL)

Before deep-diving into code, try a simple restart first — accumulated process state is the most common cause. See the [troubleshooting section in CLAUDE.md](CLAUDE.md) for the full triage checklist.

## Upstream

ClawDad is built with deep respect for [NanoClaw](https://github.com/qwibitai/nanoclaw) by [Qwibit](https://github.com/qwibitai). The core container runtime, credential proxy, and skill system started there. ClawDad now follows its own product direction. Use `/update` to pull the latest ClawDad code.

## License

MIT
