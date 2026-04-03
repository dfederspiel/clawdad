---
name: manage-groups
description: Create and manage agent groups and multi-agent teams. Use when the user wants to create a new group, create a team, list groups, delete a group, add/remove agents from a team, or troubleshoot group configuration.
---

# Group & Team Management

This skill covers creating, inspecting, and managing ClawDad agent groups and multi-agent teams from the CLI.

## Key Concepts

- **Group** — a single-agent chat in the web UI. Has a folder under `groups/web_{name}/` with a `CLAUDE.md`.
- **Team** — a multi-agent group with an `agents/` directory containing a coordinator and specialists.
- **Coordinator** — the agent that handles untriggered messages and delegates to specialists via `delegate_to_agent`. Has no trigger. Every team needs exactly one.
- **Specialist** — responds when @-mentioned or delegated to by the coordinator. Has a trigger (e.g., `@analyst`).

## Creating a Single-Agent Group

### Via API (from CLI or code):
```bash
curl -s -X POST http://localhost:3456/api/groups \
  -H 'Content-Type: application/json' \
  -d '{"name":"Weather Bot","folder":"weather","trigger":"@weather"}'
```

### Then write the agent's CLAUDE.md:
```bash
cat > groups/web_weather/CLAUDE.md << 'EOF'
# Weather Bot

You check the weather and report conditions.
EOF
```

## Creating a Multi-Agent Team

### Via API:
```bash
curl -s -X POST http://localhost:3456/api/teams \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Research Team",
    "folder": "research-team",
    "coordinator": {
      "displayName": "Coordinator",
      "instructions": "# Coordinator\n\nYou coordinate research. Delegate to @researcher for web search, @analyst for synthesis, @writer for the final briefing.\n\nUse delegate_to_agent to send work to specialists."
    },
    "specialists": [
      {"name": "researcher", "displayName": "Researcher", "trigger": "@researcher", "instructions": "# Researcher\n\nSearch the web for sources on the given topic. Return structured findings."},
      {"name": "analyst", "displayName": "Analyst", "trigger": "@analyst", "instructions": "# Analyst\n\nSynthesize research findings. Identify patterns and key insights."},
      {"name": "writer", "displayName": "Writer", "trigger": "@writer", "instructions": "# Writer\n\nProduce a polished briefing from the analysis."}
    ]
  }'
```

### Via filesystem (manual):
```
groups/web_my-team/
  CLAUDE.md                    # Group-level context
  agents/
    coordinator/
      CLAUDE.md                # Coordinator persona + delegation instructions
      agent.json               # { "displayName": "Coordinator" }
    specialist-name/
      CLAUDE.md                # Specialist persona
      agent.json               # { "displayName": "Name", "trigger": "@name" }
```

After creating via filesystem, restart the service so it discovers the new agents.

### Via the general channel (system chat):
The main agent has `register_team` which creates the full structure via IPC. Users can ask the general channel to "create a research team with a researcher, analyst, and writer."

## Listing Groups

```bash
curl -s http://localhost:3456/api/groups | python3 -m json.tool
```

Or check the database:
```bash
sqlite3 store/messages.db "SELECT jid, name, folder FROM registered_groups;"
```

## Deleting a Group

```bash
curl -s -X DELETE http://localhost:3456/api/groups/{folder}
```

Where `{folder}` is the folder name without the `web_` prefix (e.g., `weather`, `research-team`).

## Inspecting a Group

Check if it's a team (has agents/):
```bash
ls groups/web_{name}/agents/ 2>/dev/null
```

Read agent configs:
```bash
for d in groups/web_{name}/agents/*/; do
  echo "=== $(basename $d) ==="
  cat "$d/agent.json" 2>/dev/null
  echo
done
```

## Adding an Agent to an Existing Team

1. Create the agent directory:
```bash
mkdir -p groups/web_{team}/agents/{agent-name}
```

2. Write the agent's identity:
```bash
cat > groups/web_{team}/agents/{agent-name}/CLAUDE.md << 'EOF'
# Agent Name

Your persona and instructions here.
EOF
```

3. Write the agent config:
```bash
cat > groups/web_{team}/agents/{agent-name}/agent.json << 'EOF'
{
  "displayName": "Agent Name",
  "trigger": "@agent-name"
}
EOF
```

4. Update the coordinator's CLAUDE.md to list the new teammate.

5. Restart the service so agent discovery picks up the change.

## Removing an Agent from a Team

1. Delete the agent directory: `rm -rf groups/web_{team}/agents/{agent-name}`
2. Update the coordinator's CLAUDE.md to remove references to that agent.
3. Restart the service.

## Common Issues

### Group appears in sidebar but nothing happens
- Check if `agents/` exists for multi-agent groups
- Check coordinator has no trigger in `agent.json`
- Check specialists have triggers
- Look at logs: `groups/web_{name}/logs/`

### "Only the main group can register new groups/teams"
- The `register_group` and `register_team` IPC tools are restricted to the main channel (web_general)
- Other agents can't create groups — they should tell the user to ask in the main channel

### Agent hallucinates tools
- Container agents only have MCP tools from `ipc-mcp-stdio.ts`
- Real tools: `send_message`, `delegate_to_agent`, `schedule_task`, `register_group`, `register_team`
- NOT real: `TeamCreate`, `SendMessage`, `SpawnAgent` — these are hallucinations
- Fix: update the agent's CLAUDE.md to reference real tool names

### Coordinator's CLAUDE.md must document the delegation workflow
A coordinator that doesn't know its teammates will hallucinate. Always include:
- List of specialists with their triggers
- The delegation tool name: `delegate_to_agent`
- The workflow (which agent gets called when, in what order)
