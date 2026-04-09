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
| `groups/{name}/agents/{agent}/CLAUDE.md` | Per-agent identity (multi-agent groups) |
| `groups/{name}/agents/{agent}/agent.json` | Per-agent config (trigger, display name) |
| `src/agent-discovery.ts` | Agent discovery, multi-agent context injection |
| `src/agent-state.ts` | Active agent name tracking for message attribution |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Multi-Agent Groups

Groups support 1:N agents. A group with no `agents/` dir behaves as a single-agent group (backward compatible).

**Architecture:**
- **Coordinator** (no trigger) — handles untriggered messages, delegates to specialists via `delegate_to_agent` MCP tool. Every multi-agent group should have exactly one.
- **Specialists** (with trigger, e.g. `@analyst`) — respond when @-mentioned by users or delegated to by the coordinator. Cannot delegate to other agents.

**Folder structure:**
```
groups/web_my-team/
  CLAUDE.md              # Group-level context (team charter)
  agents/
    coordinator/
      CLAUDE.md          # Coordinator identity and orchestration rules
      agent.json         # { "displayName": "Coordinator" }  (no trigger)
    analyst/
      CLAUDE.md          # Specialist identity
      agent.json         # { "displayName": "Analyst", "trigger": "@analyst" }
```

**How it works:**
- On startup, `discoverAgents()` scans `agents/` subdirs for each group
- User messages route to agents by @-mention trigger matching (anywhere in message)
- Untriggered messages go to the coordinator (first agent without a trigger)
- Coordinators delegate via `mcp__nanoclaw__delegate_to_agent` IPC tool
- Delegations run in **parallel** via `GroupQueue.enqueueDelegation` — specialists spawn concurrently alongside the coordinator
- Delegation containers **exit immediately** after responding (no idle loop) — `isDelegation` flag in agent-runner skips `waitForIpcMessage`
- When all delegations complete, the queue automatically re-triggers the coordinator via `enqueueMessageCheck`
- Each agent gets its own Claude session, container, and CLAUDE.md
- All agents share `/workspace/group/` filesystem for artifacts
- Multi-agent context is auto-injected into prompts (role, teammates, instructions)
- Bot messages carry the agent's display name as `sender_name` (re-asserted before each `sendMessage` to handle parallel clobbering)
- Multi-agent groups **never use the message loop piping path** — all messages route through `processGroupMessages` with `includeBotMessages = true` so coordinators see specialist output

**Creating teams:**
- **Web UI**: "New Agent" → "Create team" — coordinator + dynamic specialist list
- **API**: `POST /api/teams` with `{ name, folder, coordinator, specialists[] }`
- **Filesystem**: Create `agents/` subdirectories with `CLAUDE.md` + `agent.json`

**Key files:** `src/agent-discovery.ts`, `src/agent-state.ts`, `src/group-queue.ts` (enqueueDelegation, runDelegation), `src/index.ts` (processGroupMessages, onDelegateToAgent), `container/agent-runner/src/ipc-mcp-stdio.ts` (delegate_to_agent tool), `src/channels/web.ts` (POST /api/teams)

## Automation Rules (Phase 1: Logging Only)

Deterministic orchestrator-level rules that evaluate on events and log what *would* fire, without executing actions. This avoids burning an LLM turn for obvious routing decisions.

**How it works:**
- Rules are defined in `group-config.json` under an `automation` array
- The orchestrator evaluates rules on three event types: inbound messages, agent results, and task completions
- Matched rules emit structured `[automation] rule matched (dry-run)` log entries
- No actions execute in Phase 1 — this validates the rule schema and hook points

**Rule format in `group-config.json`:**
```json
{
  "automation": [
    {
      "id": "auto-review",
      "enabled": true,
      "when": { "event": "message", "pattern": "@review" },
      "then": [{ "type": "delegate_to_agent", "agent": "reviewer", "silent": true }]
    }
  ]
}
```

**Trigger types:**
- `message` — fires on inbound messages. Optional filters: `pattern` (regex), `sender` (`"user"` or `"assistant"`)
- `agent_result` — fires when an agent completes. Optional filters: `agent` (name), `contains` (substring)
- `task_completed` — fires when a scheduled task succeeds. Optional filters: `taskId`, `groupFolder`

**Action types (logged but not executed in Phase 1):**
- `delegate_to_agent` — route to a specific agent (`agent`, `silent`, `messageTemplate`)
- `fan_out` — route to multiple agents (`agents[]`, `silent`)
- `post_system_note` — emit a system message (`text`, `visible`)
- `set_subtitle` — update group subtitle (`text`)

**Hook points:**
- `src/index.ts` `processGroupMessages` — evaluates on messages (after trigger checks) and agent results (on success)
- `src/task-scheduler.ts` `runTask` — evaluates on task completion

**Key files:** `src/automation-rules.ts` (types, loader, evaluator, trace emitter), `src/automation-rules.test.ts`

**Design doc:** `docs/design-orchestrator-automation-rules.md` — full design with Phase 2-4 roadmap (live delegation, group UI, trace viewer)

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

## Intermediate Text & Message Streaming

Agents emit intermediate TEXT markers during long runs. Each marker becomes its own message via `sendMessage`. Consecutive assistant messages are visually merged in the UI using CSS adjacent sibling selectors (`[data-role="assistant"] + [data-role="assistant"]`), collapsing the gap and squaring off corners so they appear as one growing response.

**Design note:** A server-side `updateMessage` approach was tried first (accumulate text into a single DB row, broadcast `message_update` SSE events). It caused ordering bugs on refresh and state leaks across warm pool queries. The CSS-only approach is stateless and immune to those issues. The `updateMessage` method and `message_update` SSE handler still exist in the codebase but are currently unused.

## Secrets / Credentials

All credentials live in `.env` (untracked). Two types:

- **Anthropic credentials** — routed through the credential proxy (`src/credential-proxy.ts`) which injects the real credential. Containers get `ANTHROPIC_BASE_URL` pointing at the proxy and a placeholder key.
- **Service credentials** (GitHub, GitLab, etc.) — also routed through the credential proxy via its `/forward` endpoint. Containers receive placeholder values (`__CRED_GITHUB_TOKEN__`) instead of real tokens. The `api.sh` wrapper routes requests through the proxy, which substitutes placeholders with real values from `.env` at request time. New credentials are available immediately — no container restart needed.

### Anthropic Auth Modes

The credential proxy supports two auth modes, auto-detected from `.env`:

| Mode | `.env` variable | Header sent | When to use |
|------|----------------|-------------|-------------|
| **API key** | `ANTHROPIC_API_KEY=sk-ant-api03-...` | `x-api-key` | Direct API keys from console.anthropic.com |
| **OAuth** | `ANTHROPIC_AUTH_TOKEN=sk-ant-oat01-...` | `Authorization: Bearer` | OAuth tokens (e.g. from `claude setup-token`) |

**Detection logic:** If `ANTHROPIC_API_KEY` is set, the proxy uses api-key mode. Otherwise it falls back to OAuth mode using `ANTHROPIC_AUTH_TOKEN` (or `CLAUDE_CODE_OAUTH_TOKEN`).

**Refreshing an OAuth token (e.g. after `claude setup-token`):**
```bash
# 1. Copy the new token from Claude Code's credential store into .env
python -c "
import json
d = json.load(open('$HOME/.claude/.credentials.json'))
token = d['claudeAiOauth']['accessToken']
print(token)
"
# 2. Set it in .env as ANTHROPIC_AUTH_TOKEN (NOT ANTHROPIC_API_KEY)
# 3. Restart ClawDad — the proxy caches the token at startup
```

**Common mistake:** OAuth tokens (`sk-ant-oat01-...`) set as `ANTHROPIC_API_KEY` will fail with "Invalid API key" because the proxy sends them as `x-api-key` instead of `Authorization: Bearer`. Always use `ANTHROPIC_AUTH_TOKEN` for OAuth tokens.

**Adding service credentials:** Agents use `mcp__nanoclaw__request_credential` which opens a web popup → user enters secret → saved to `.env`. Or add manually:
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
| `/restart` | Build and restart the service (no git pull) |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/report-bug` | Triage a failure and, if confirmed as a core platform bug, file a sanitized issue against `dfederspiel/clawdad` |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Validating Changes

After modifying delegation logic, automation rules, or agent behavior, validate with the send → poll → verify cycle:

1. **Capture timestamp** before sending: `SINCE=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)`
2. **Send** a test message via the API: `curl -sf -X POST http://localhost:3456/api/send -H 'Content-Type: application/json' -d '{"jid":"web:test-team","content":"...","sender":"David"}'`
3. **Poll** for responses using the `since` param (avoids the 100-message default cap): `curl -sf "http://localhost:3456/api/messages/web:test-team?since=${SINCE}"`
4. **Check logs** for delegation routing, retrigger decisions, and cost: `tail -50 logs/nanoclaw.log | grep -iE "delegation|retrigger|automation|usage stored"`
5. **Verify cost** per agent run in the log lines tagged `Agent run usage stored` (fields: `agent`, `cost`, `turns`, `containerReuse`)

When changing a group's CLAUDE.md, the warm pool container still has the old instructions. Kill it to force a cold start: `docker ps --format '{{.Names}}' | grep <agent> | xargs -r docker stop`

Use `/test-agent` for the full automated cycle, or run the steps manually when you need finer control.

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management (if installed as a service via `/setup`):
```bash
# macOS (launchd) — service name is com.clawdad.clawdad
launchctl load ~/Library/LaunchAgents/com.clawdad.clawdad.plist
launchctl unload ~/Library/LaunchAgents/com.clawdad.clawdad.plist
launchctl kickstart -k gui/$(id -u)/com.clawdad.clawdad  # restart
# If kickstart doesn't change the PID, kill the process directly:
# kill $(pgrep -f 'node dist/index.js')  # launchd will auto-restart

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

## Instance Architecture

Single active instance (as of 2026-04-08):

| Instance | Location | Service Unit | Channels | Trigger |
|----------|----------|-------------|----------|---------|
| macOS | `/Users/davidaf/code/clawdad` | `com.clawdad.clawdad` (launchd) | Web UI (`:3456`) | `@Andy` |

**Log files differ by launch method:**
| How started | stdout/stderr log | Why |
|-------------|------------------|-----|
| `launchctl` (service) | `logs/clawdad.log`, `logs/clawdad.error.log` | plist `StandardOutPath`/`StandardErrorPath` |
| `npm run dev` / manual | `logs/nanoclaw.log` | pino file transport in code |
| `node dist/index.js >> logs/X.log` | wherever you redirect | manual |

Always check the right log file for the running instance. Use `launchctl print gui/$(id -u)/com.clawdad.clawdad` to see `stdout path`.

**Stale services:** Periodically audit `launchctl list | grep -iE 'claw|nanoclaw'`. Old services (e.g. `com.nanoclaw.nanoclaw`) that crash-loop can interfere with running containers. Remove them: `launchctl bootout gui/$(id -u)/<name> && rm ~/Library/LaunchAgents/<name>.plist`.

## Troubleshooting

**Container exit 137 (SIGKILL) — triage checklist:**
Exit 137 means the container received SIGKILL. Before deep-diving into code, work through this checklist in order:

1. **Restart the service first.** Accumulated process state (orphaned child processes, leaked timers, retry cascades) is the most common cause. Kill the process and let launchd restart: `kill $(pgrep -f 'node dist/index.js')`. Re-test immediately.
2. **Check for stale services.** Run `launchctl list | grep -iE 'claw|nanoclaw'`. Any service besides `com.clawdad.clawdad` that crash-loops can interfere — it may run orphan cleanup that kills your containers. Remove with `launchctl bootout gui/$(id -u)/<name>`.
3. **Check Docker events.** `docker events --filter event=kill --filter event=die --since 5m --format '{{.Time}} {{.Action}} signal={{.Actor.Attributes.signal}} name={{.Actor.Attributes.name}}'` — look at the SIGTERM→SIGKILL gap. 1-second gap = client disconnection (not `docker stop`). 10-second gap = normal `docker stop`.
4. **Check for concurrent instances.** `ps aux | grep 'dist/index.js' | grep -v grep` — there should be exactly one process.
5. **Only then** trace code paths — check `stopContainer` stack trace logs, idle timers, stale container cleanup in `spawnContainer`.

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
