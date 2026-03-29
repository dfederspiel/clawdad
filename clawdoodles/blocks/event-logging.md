---
id: event-logging
teaches: "Structured event logging to JSONL for audit trails"
tools: [event-log.sh]
complexity: beginner
depends_on: []
---

## Event Logging

Every agent should log domain events for auditability. Events are stored as JSONL (one JSON object per line) in `/workspace/group/event-log.jsonl`.

### Logging events

Use the event-log script with an event type and key=value pairs:

```bash
# Log a task completion
/workspace/scripts/event-log.sh task_completed \
  items_processed=5 \
  duration_seconds=12

# Log a user preference change
/workspace/scripts/event-log.sh preferences_updated \
  field="topics" \
  action="added" \
  value="AI safety"

# Log a scheduled run
/workspace/scripts/event-log.sh scheduled_run \
  trigger="cron" \
  items_found=3
```

The script auto-adds a timestamp and coerces types (strings, numbers, booleans).

### Designing event types

Each agent should define 3-6 event types that capture its key operations. Good event types are:

- **Domain-specific** — what happened in the agent's world (not HTTP logs)
- **Concise** — one event per meaningful action, not per API call
- **Queryable** — consistent field names across events of the same type

### Showing the audit trail

When a user asks "what have you done?" or "show activity", read from the event log:

```bash
tail -20 /workspace/group/event-log.jsonl
```

Format as a table:

:::blocks
[{"type":"table","columns":["Time","Event","Details"],"rows":[
  ["9:00 AM","scheduled_run","Found 3 new items"],
  ["9:01 AM","notification_sent","Sent summary to user"]
]}]
:::
