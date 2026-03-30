# ClawDad

Agent orchestrator running Claude in isolated containers. Web UI is the primary interface. Based on [NanoClaw](https://github.com/qwibitai/nanoclaw).

## Getting Started

New users should run `claude` in the terminal and say "help me get set up" (or `/setup`). Claude walks through everything: Node.js, OneCLI, Docker, Anthropic credentials, container build, and web UI start. No manual `npm install` needed.

The web UI runs at `http://localhost:3456`. Most users interact through:
- **Web UI** — chat with agents, create from templates, review tasks
- **Claude Code** — add templates, tune agent behavior, debug issues

## Quick Context

Single Node.js process with web UI channel (always-on) and optional messaging channels. Agents run via Claude Agent SDK in Docker containers. Each group has isolated filesystem and memory. Credentials flow through OneCLI Agent Vault — agents never see raw API keys.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/health.ts` | Prerequisite checks (Docker, OneCLI, Anthropic, container image) |
| `src/channels/web.ts` | Web UI channel, API endpoints, health/register routes |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy (OneCLI)

API keys, OAuth tokens, and auth credentials are managed by the **OneCLI Agent Vault** — a local gateway that intercepts outbound HTTPS requests from containers and injects credentials at request time. Agents never see raw keys. See [docs/CREDENTIALS.md](docs/CREDENTIALS.md) for the full reference.

The gateway starts automatically when agents run (via the OneCLI SDK's `applyContainerConfig`). You don't need to start it manually.

**Quick reference:**

```bash
onecli secrets list                     # List registered secrets
onecli secrets create --name NAME \     # Register a new credential
  --type anthropic|generic \
  --value TOKEN \
  --host-pattern api.example.com \
  --header-name Authorization           # (required for --type generic)
curl -sf http://127.0.0.1:10254/health  # Verify gateway is running (after an agent starts)
```

**Config vs secrets:** Non-secret values (URLs, account IDs) pass to containers as env vars via `PASSTHROUGH_ENV_PREFIXES` in `container-runner.ts`. Secrets flow through the gateway only.

**Custom Anthropic endpoint:** Set `ANTHROPIC_BASE_URL` in `.env` AND match the OneCLI host pattern — both are required or you'll get silent "Invalid API key" errors.

## Reset

Run `./scripts/reset.sh` to wipe all runtime state and return to a clean template. This removes the database, IPC state, logs, and user-created groups while preserving `.env`, template groups (`main/`, `global/`), and OneCLI vault credentials. Use `--yes` to skip confirmation.

## Skills

Four types of skills exist in ClawDad. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/update` | Pull latest code, rebuild, restart service |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials to it |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management (if installed as a service via `/setup`):
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.clawdad.plist
launchctl unload ~/Library/LaunchAgents/com.clawdad.plist
launchctl kickstart -k gui/$(id -u)/com.clawdad  # restart

# Linux (systemd)
systemctl --user start clawdad
systemctl --user stop clawdad
systemctl --user restart clawdad
```

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
