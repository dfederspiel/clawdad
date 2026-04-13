---
name: add-telegram-swarm
description: Add Agent Swarm (Teams) support to Telegram. Each subagent gets its own bot identity in the group. Requires Telegram channel to be set up first (use /add-telegram). Triggers on "agent swarm", "agent teams telegram", "telegram swarm", "bot pool".
---

# Add Agent Swarm to Telegram

This skill adds Agent Teams (Swarm) support to an existing Telegram channel. Each subagent in a team gets its own bot identity in the Telegram group, so users can visually distinguish which agent is speaking.

**Prerequisite**: Telegram must already be set up via the `/add-telegram` skill. If `src/telegram.ts` does not exist or `TELEGRAM_BOT_TOKEN` is not configured, tell the user to run `/add-telegram` first.

## How It Works

- The **main bot** receives messages and sends lead agent responses (already set up by `/add-telegram`)
- **Pool bots** are send-only — each gets a Grammy `Api` instance (no polling)
- When a subagent calls `send_message` with a `sender` parameter, the host assigns a pool bot and renames it to match the sender's role
- Messages appear in Telegram from different bot identities

```
Subagent calls send_message(text: "Found 3 results", sender: "Researcher")
  -> MCP writes IPC file with sender field
  -> Host IPC watcher picks it up
  -> Assigns pool bot #2 to "Researcher" (round-robin, stable per-group)
  -> Renames pool bot #2 to "Researcher" via setMyName
  -> Sends message via pool bot #2's Api instance
  -> Appears in Telegram from "Researcher" bot
```

## Prerequisites

### 1. Create Pool Bots

Tell the user:

> I need you to create 3-5 Telegram bots to use as the agent pool. These will be renamed dynamically to match agent roles.
>
> 1. Open Telegram and search for `@BotFather`
> 2. Send `/newbot` for each bot:
>    - Give them any placeholder name (e.g., "Bot 1", "Bot 2")
>    - Usernames like `myproject_swarm_1_bot`, `myproject_swarm_2_bot`, etc.
> 3. Copy all the tokens
> 4. Add all bots to your Telegram group(s) where you want agent teams

Wait for user to provide the tokens.

### 2. Disable Group Privacy for Pool Bots

Tell the user:

> **Important**: Each pool bot needs Group Privacy disabled so it can send messages in groups.
>
> For each pool bot in `@BotFather`:
> 1. Send `/mybots` and select the bot
> 2. Go to **Bot Settings** > **Group Privacy** > **Turn off**
>
> Then add all pool bots to your Telegram group(s).

## Implementation Steps

Read `${CLAUDE_SKILL_DIR}/references/implementation.md` for full code and instructions, then execute each step:

1. **Update Configuration** — add `TELEGRAM_BOT_POOL` to `src/config.ts`
2. **Add Bot Pool to Telegram Module** — add `Api` import, pool state, `initBotPool()`, and `sendPoolMessage()` to `src/telegram.ts`
3. **Add sender Parameter to MCP Tool** — update `send_message` in `container/agent-runner/src/ipc-mcp-stdio.ts` with optional `sender` field
4. **Update Host IPC Routing** — route `tg:` messages with `sender` through pool in `src/ipc.ts`; init pool in `src/index.ts`
5. **Update CLAUDE.md Files** — add formatting rules to `groups/global/CLAUDE.md`, update heading in existing groups, add Agent Teams section to Telegram groups
6. **Update Environment** — add `TELEGRAM_BOT_POOL=TOKEN1,TOKEN2,...` to `.env` and sync to `data/env/env`
7. **Rebuild and Restart** — `npm run build && ./container/build.sh` then restart service
8. **Test** — user sends a multi-agent task in Telegram group and verifies pool bot messages

## Troubleshooting

Read `${CLAUDE_SKILL_DIR}/references/troubleshooting.md` for architecture notes, debugging steps, and removal instructions.
