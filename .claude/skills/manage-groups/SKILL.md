---
name: manage-groups
description: Create and manage agent groups and multi-agent teams. Use when the user wants to create a new group, create a team, list groups, delete a group, add/remove agents from a team, or troubleshoot group configuration.
---

# Group & Team Management

This skill covers creating, inspecting, and managing ClawDad agent groups and multi-agent teams.

## Key Concepts

- **Group** — a single-agent chat in the web UI. Has a folder under `groups/web_{name}/` with a `CLAUDE.md`.
- **Team** — a multi-agent group with an `agents/` directory containing a coordinator and specialists.
- **Coordinator** — handles untriggered messages and delegates via `delegate_to_agent`. Has no trigger. Every team needs exactly one.
- **Specialist** — responds when @-mentioned or delegated to. Has a trigger (e.g., `@analyst`).

## Designing Effective Teams

Before creating a team, read the architecture guide for context flow, CLAUDE.md layering, delegation patterns, and common mistakes:

`Read ${CLAUDE_SKILL_DIR}/references/architecture-guide.md`

## Creating a Single-Agent Group

```bash
curl -s -X POST http://localhost:3456/api/groups \
  -H 'Content-Type: application/json' \
  -d '{"name":"Weather Bot","folder":"weather","trigger":"@weather"}'
```

Then write `groups/web_weather/CLAUDE.md` with the agent's instructions.

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
      "instructions": "# Coordinator\n\nDelegate to @researcher for web search, @analyst for synthesis."
    },
    "specialists": [
      {"name": "researcher", "displayName": "Researcher", "trigger": "@researcher",
       "instructions": "# Researcher\n\nSearch the web for sources on the given topic."}
    ]
  }'
```

### Via filesystem:
```
groups/web_my-team/
  CLAUDE.md                    # Group-level shared context
  agents/
    coordinator/
      CLAUDE.md                # Coordinator identity + delegation rules
      agent.json               # { "displayName": "Coordinator" }
    specialist-name/
      CLAUDE.md                # Specialist identity
      agent.json               # { "displayName": "Name", "trigger": "@name" }
```

After creating via filesystem, restart the service so it discovers the new agents.

### Via the general channel:
The main agent has `register_team` which creates the full structure via IPC.

## Listing Groups

```bash
curl -s http://localhost:3456/api/groups | python3 -m json.tool
```

## Deleting a Group

```bash
curl -s -X DELETE http://localhost:3456/api/groups/{folder}
```

Where `{folder}` is the folder name without the `web_` prefix.

## Inspecting a Group

```bash
# Check if it's a team
ls groups/web_{name}/agents/ 2>/dev/null

# Read agent configs
for d in groups/web_{name}/agents/*/; do
  echo "=== $(basename $d) ===" && cat "$d/agent.json" 2>/dev/null && echo
done
```

## Adding an Agent to a Team

1. `mkdir -p groups/web_{team}/agents/{agent-name}`
2. Write `CLAUDE.md` (agent identity) and `agent.json` (displayName + trigger)
3. Update coordinator's CLAUDE.md to list the new teammate
4. Restart the service

## Removing an Agent

1. `rm -rf groups/web_{team}/agents/{agent-name}`
2. Update coordinator's CLAUDE.md to remove references
3. Restart the service

## Troubleshooting

`Read ${CLAUDE_SKILL_DIR}/references/troubleshooting.md`
