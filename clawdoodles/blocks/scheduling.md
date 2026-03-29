---
id: scheduling
teaches: "Cron scheduling, interval tasks, pre-check scripts, task lifecycle"
tools: [schedule_task, pause_task, resume_task, cancel_task, update_task]
complexity: beginner
depends_on: [first-run]
---

## Scheduling

Agents can run on their own using scheduled tasks. Two modes:

### Cron scheduling (specific times)

```
Use the schedule_task MCP tool:
- schedule_type: "cron"
- schedule_value: "0 9 * * 1-5"  (weekdays at 9am — adjust to user's answer)
- prompt: "Describe what the agent should do when it wakes up. Include the config path to read."
- context_mode: "group"
```

After creating the task, confirm with a success alert:

:::blocks
[{"type":"alert","level":"success","title":"Scheduled!","body":"I'll run [description] every [schedule].\n\nThis uses **schedule_task** — one of the most powerful agent features. I run on my own, even when you're not here."}]
:::

### Interval scheduling (periodic checks)

```
Use the schedule_task MCP tool:
- schedule_type: "interval"
- schedule_value: "30m"  (every 30 minutes — adjust to user's preference)
- prompt: "Describe the periodic check. Include config path and what state to compare against."
- context_mode: "group"
```

### Pre-check scripts

For interval tasks, you can add a lightweight pre-check script that runs *before* waking the agent. This saves resources — the agent only starts if the pre-check says something changed.

```
- script: "#!/bin/bash\n# Quick check — only wake agent if something is new\ncurl -sf https://example.com/api/status | md5sum > /tmp/current\ndiff -q /tmp/current /workspace/group/last-hash.txt > /dev/null 2>&1\nif [ $? -ne 0 ]; then\n  cp /tmp/current /workspace/group/last-hash.txt\n  echo '{\"wakeAgent\": true}'\nelse\n  echo '{\"wakeAgent\": false}'\nfi"
```

### Task lifecycle

Users can manage their scheduled tasks:

| Command | Action |
|---------|--------|
| "pause" / "stop" | Cancel the scheduled task |
| "resume" / "start again" | Recreate the scheduled task |
| "change schedule" | Update the schedule (cancel + recreate) |

When pausing/resuming, use the `cancel_task` and `schedule_task` MCP tools respectively.
