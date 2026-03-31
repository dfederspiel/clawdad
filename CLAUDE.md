# ClawDad

Agent orchestrator running Claude in isolated containers. Web UI is the primary interface. Based on [NanoClaw](https://github.com/qwibitai/nanoclaw).

## Getting Started

New users should run `claude` in the terminal and say "help me get set up" (or `/setup`). Claude walks through everything: Node.js, Docker, Anthropic credentials, container build, and web UI start. No manual `npm install` needed.

The web UI runs at `http://localhost:3456`. Most users interact through:
- **Web UI** — chat with agents, create from templates, review tasks
- **Claude Code** — add templates, tune agent behavior, debug issues

## Quick Context

Single Node.js process with web UI channel (always-on) and optional messaging channels. Agents run via Claude Agent SDK in Docker containers. Each group has isolated filesystem and memory. Credentials are stored in `.env` and passed to containers as env vars (Anthropic key goes through a local proxy).

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/health.ts` | Prerequisite checks (Docker, Anthropic, container image) |
| `src/channels/web.ts` | Web UI channel, API endpoints, health/register routes |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Usage Tracking & Cost Observability

Every agent run records token usage, cost, duration, and turn count. This data is critical for optimization — expensive or slow operations should be flagged and investigated.

**How it works:**
- The Claude Agent SDK returns usage on each `result` message (input/output tokens, cache tokens, cost, duration, turns)
- The agent-runner extracts these via `PROGRESS` and `OUTPUT` markers on stdout
- The host stores each run in the `agent_runs` table and attaches usage JSON to the bot message in `messages.usage`
- Live tool activity streams via `agent_progress` SSE events during runs

**Key files:**
- `container/agent-runner/src/index.ts` — extracts usage from SDK result messages, emits progress markers for tool calls
- `src/container-runner.ts` — parses `OUTPUT` and `PROGRESS` markers from container stdout
- `src/db.ts` — `agent_runs` table, `storeAgentRun()`, `getUsageStats()`, `attachUsageToLastBotMessage()`
- `src/channels/web.ts` — `/api/usage`, `/api/transcript` endpoints; SSE events `usage_update`, `agent_progress`
- `web/js/components/Message.js` — per-message usage footer with expandable tool history
- `web/js/components/TypingIndicator.js` — live tool activity during agent runs
- `web/js/components/TelemetryPanel.js` — 24h usage rollup with per-group cost breakdown

**API endpoints:**
- `GET /api/usage?hours=24` — aggregated token/cost stats with per-group breakdown
- `GET /api/usage/latest?jid=...` — latest run metrics for a specific chat
- `GET /api/transcript?group=folder` — full session timeline (tool calls, text, user messages)

**In the UI:**
- Typing indicator shows elapsed time + real-time tool activity (tool name + summary)
- Each assistant message shows a usage footer: `duration · turns · tokens · cost`
- Click the footer to expand and see the full tool call chain
- Telemetry panel shows 24h totals, cache stats, and cost-by-group

## Secrets / Credentials

All credentials live in `.env` (untracked). Two types:

- **Anthropic API key** — routed through a local HTTP proxy (`src/credential-proxy.ts`) that injects the real key. Containers get `ANTHROPIC_BASE_URL` pointing at the proxy and a placeholder key.
- **Service credentials** (GitHub, GitLab, etc.) — passed directly as env vars to containers. Agents use them in curl headers: `curl -H "Authorization: token $GITHUB_TOKEN" ...`

**Adding credentials:** Agents use `mcp__nanoclaw__request_credential` which opens a web popup → user enters secret → saved to `.env`. Or add manually:
```bash
echo 'GITHUB_TOKEN=ghp_xxxxx' >> .env
echo 'GITLAB_TOKEN=glpat-xxxxx' >> .env
```

Variables matching `*_TOKEN`, `*_KEY`, `*_SECRET`, or `*_PASSWORD` are automatically forwarded to containers (excluding `ANTHROPIC_*` and `CLAUDE_CODE_*` which go through the proxy).

**Custom Anthropic endpoint:** Set `ANTHROPIC_BASE_URL` in `.env`.

## Reset

Run `./scripts/reset.sh` to wipe all runtime state and return to a clean template. This removes the database, IPC state, logs, and user-created groups while preserving `.env` and template groups (`main/`, `global/`). Use `--yes` to skip confirmation.

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
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw

# Windows — both services start on login via scripts/start-clawdad.bat
# (installed to the Windows Startup folder)
# To start manually:
node dist/index.js >> logs/clawdad.log 2>&1 &          # Web UI (Windows)
wsl -d Ubuntu -- sleep infinity                          # WSL (triggers systemd → Discord + Gmail)
```

## Windows Setup Notes

ClawDad runs on Windows via Git Bash. These are the known gotchas:

**Docker Desktop PATH:** After installing Docker Desktop via `winget`, the `docker` CLI is not in the Git Bash PATH until you add it manually:
```bash
echo 'export PATH="/c/Program Files/Docker/Docker/resources/bin:$PATH"' >> ~/.bashrc
```
Restart your shell after adding this.

**pm2 log capture:** pm2 may silently fail to capture stdout/stderr on Windows. If `pm2 logs` shows nothing, run the service directly instead:
```bash
node dist/index.js > logs/clawdad.log 2>&1 &
```

**Service auto-start:** On Windows, both instances start on login via `scripts/start-clawdad.bat` (copied to the Startup folder). This starts the Windows web UI and boots WSL, which triggers `nanoclaw.service` via systemd. To verify after reboot:
```bash
curl -sf http://localhost:3456/health    # Windows web UI
wsl -d Ubuntu -e bash -ic "systemctl --user status nanoclaw.service"  # WSL Discord + Gmail
```

## Multi-Instance Architecture

This install runs two separate instances:

| Instance | Location | Channels | Trigger | Auto-start |
|----------|----------|----------|---------|------------|
| Windows | `C:\Users\david\code\clawdad-home` | Web UI (`:3456`) | `@DavidAF` | Startup folder bat |
| WSL Ubuntu | `/home/david/code/nanoclaw` | Discord, Gmail | `@Andy` | systemd user service |

**Important:** The Discord bot token can only have one active gateway connection. Starting multiple instances that include Discord will cause the bot to appear offline. Only the WSL nanoclaw instance should run Discord.

**WSL gotcha:** Node is installed via Linuxbrew (`/home/linuxbrew/.linuxbrew/bin/node`) and is not in the non-interactive PATH. The systemd unit uses the full path. If starting manually, use `bash -ic` or the full node path.

**Stale WSL services:** There are inactive systemd units (`com-nanoclaw-clawdad-test.service`, `com-nanoclaw-test2.service`) pointing at test repos. These are disabled. Only `nanoclaw.service` should be enabled.

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
