---
id: file-persistence
teaches: "agent-config.json, state files, history tracking in /workspace/group/"
tools: []
complexity: beginner
depends_on: []
---

## File Persistence

Each agent has a writable directory at `/workspace/group/` that persists across conversations. Use it for configuration, state, and history.

### Standard files

| File | Purpose |
|------|---------|
| `agent-config.json` | User preferences and configuration |
| `event-log.jsonl` | Domain event audit trail (via event-log.sh) |
| `api-logs/` | API request/error logs (auto-created by api.sh) |

### State tracking

For agents that poll or compare data over time, maintain a state file:

```json
// /workspace/group/last-poll.json
{
  "last_check": "2026-03-28T10:00:00Z",
  "items": {
    "item-1": {"status": "active", "updated": "2026-03-28T09:30:00Z"},
    "item-2": {"status": "pending", "updated": "2026-03-27T15:00:00Z"}
  }
}
```

On each run, compare current state against the saved state to detect changes.

### History tracking

For agents that deliver content (briefings, reports), track what's been shown:

```json
// /workspace/group/history.json
{
  "last_delivery": "2026-03-28T09:00:00Z",
  "items_shown": ["url1", "url2"],
  "user_preferences_refined": ["prefers deep dives on topic X"]
}
```

### Reading and writing

Always read before writing to avoid losing data:

```bash
# Read config
cat /workspace/group/agent-config.json

# Write config (atomic — write complete JSON)
cat > /workspace/group/agent-config.json << 'EOF'
{
  "key": "value",
  "setup_complete": true
}
EOF
```

### Global read-only access

The `/workspace/global/` directory (read-only) contains shared data accessible to all groups. Use it for cross-agent information sharing.
