## Architecture Notes

- Pool bots use Grammy's `Api` class — lightweight, no polling, just send
- Bot names are set via `setMyName` — changes are global to the bot, not per-chat
- A 2-second delay after `setMyName` allows Telegram to propagate the name change before the first message
- Sender→bot mapping is stable within a group (keyed as `{groupFolder}:{senderName}`)
- Mapping resets on service restart — pool bots get reassigned fresh
- If pool runs out, bots are reused (round-robin wraps)

## Troubleshooting

### Pool bots not sending messages

1. Verify tokens: `curl -s "https://api.telegram.org/botTOKEN/getMe"`
2. Check pool initialized: `grep "Pool bot" logs/nanoclaw.log`
3. Ensure all pool bots are members of the Telegram group
4. Check Group Privacy is disabled for each pool bot

### Bot names not updating

Telegram caches bot names client-side. The 2-second delay after `setMyName` helps, but users may need to restart their Telegram client to see updated names immediately.

### Subagents not using send_message

Check the group's `CLAUDE.md` has the Agent Teams instructions. The lead agent reads this when creating teammates and must include the `send_message` + `sender` instructions in each teammate's prompt.

## Removal

To remove Agent Swarm support while keeping basic Telegram:

1. Remove `TELEGRAM_BOT_POOL` from `src/config.ts`
2. Remove pool code from `src/telegram.ts` (`poolApis`, `senderBotMap`, `initBotPool`, `sendPoolMessage`)
3. Remove pool routing from IPC handler in `src/index.ts` (revert to plain `sendMessage`)
4. Remove `initBotPool` call from `main()`
5. Remove `sender` param from MCP tool in `container/agent-runner/src/ipc-mcp-stdio.ts`
6. Remove Agent Teams section from group CLAUDE.md files
7. Remove `TELEGRAM_BOT_POOL` from `.env`, `data/env/env`, and launchd plist/systemd unit
8. Rebuild: `npm run build && ./container/build.sh && launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist && launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist` (macOS) or `npm run build && ./container/build.sh && systemctl --user restart nanoclaw` (Linux)
