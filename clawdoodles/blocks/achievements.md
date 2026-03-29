---
id: achievements
teaches: "Gamification via unlock_achievement, milestone celebrations"
tools: [unlock_achievement]
complexity: beginner
depends_on: []
---

## Achievements

Agents can unlock achievements — visual celebrations that gamify the learning experience. Each achievement fires once and shows a toast notification in the web UI.

### Unlocking achievements

Call the `unlock_achievement` MCP tool:

```
Use unlock_achievement with:
- achievement_id: "the_achievement_id"
```

### Standard achievement hooks

These are common milestones any agent can use:

| Achievement | When to unlock |
|-------------|---------------|
| `first_contact` | User completes initial setup with any agent |
| `clockwork` | User creates their first scheduled task |
| `researcher` | Agent performs a web search for the user |
| `proactive` | Agent sends an unsolicited message (from scheduled task) |
| `dashboard` | Agent renders rich output blocks (cards, tables, stats) |
| `good_memory` | Agent recalls user preferences from a previous session |

### Custom achievements

Agents can define their own achievement IDs for domain-specific milestones. Keep them fun and meaningful:

- Name them after what the user accomplished, not what the agent did
- Pick moments that feel like genuine progress
- Don't over-award — 3-6 achievements per agent is the sweet spot

### Achievement announcement pattern

When unlocking, weave it naturally into the conversation. Don't make it the focus — it's a bonus:

> [Normal response content]

Then call `unlock_achievement` with the ID. The UI handles the toast notification automatically.
