# Group & Team Troubleshooting

## Group appears in sidebar but nothing happens
- Check if `agents/` exists for multi-agent groups
- Check coordinator has no trigger in `agent.json`
- Check specialists have triggers
- Look at logs: `groups/web_{name}/logs/`

## "Only the main group can register new groups/teams"
- The `register_group` and `register_team` IPC tools are restricted to the main channel (web_general)
- Other agents can't create groups — they should tell the user to ask in the main channel

## Agent hallucinates tools
- Container agents only have MCP tools from `ipc-mcp-stdio.ts`
- Real tools: `send_message`, `delegate_to_agent`, `schedule_task`, `register_group`, `register_team`
- NOT real: `TeamCreate`, `SendMessage`, `SpawnAgent` — these are hallucinations
- Fix: update the agent's CLAUDE.md to reference real tool names

## Coordinator's CLAUDE.md must document the delegation workflow
A coordinator that doesn't know its teammates will hallucinate. Always include:
- List of specialists with their triggers
- The delegation tool name: `delegate_to_agent`
- The workflow (which agent gets called when, in what order)

## Warm pool serves stale instructions
After editing CLAUDE.md files, the warm pool container still has old instructions cached.
Kill it to force a cold start: `docker ps --format '{{.Names}}' | grep {agent} | xargs -r docker stop`
