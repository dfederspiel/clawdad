---
id: proactive-messaging
teaches: "Agents sending messages on their own via send_message"
tools: [send_message]
complexity: beginner
depends_on: [scheduling]
---

## Proactive Messaging

Agents can send messages without the user asking first. This is how scheduled tasks deliver results.

### Sending proactive messages

Use the `send_message` MCP tool to deliver content to the user:

```
Use send_message with:
- content: "Your message here — supports markdown and rich output blocks"
```

### When to use proactive messaging

- **Scheduled reports** — morning briefings, daily summaries, weekly digests
- **Alert conditions** — something changed, threshold exceeded, error detected
- **Task completion** — a long-running job finished

### Teaching the concept

The first time an agent sends a proactive message (from a scheduled task), explain what happened:

:::blocks
[{"type":"alert","level":"info","title":"Did you notice?","body":"I sent this on my own — you didn't have to ask! Agents can send proactive messages using **send_message**. Any scheduled task can reach out to you."}]
:::

### Guidelines

- **Don't spam.** Only send proactive messages when there's something meaningful to report.
- **If nothing changed, stay quiet.** A polling task that finds no updates should NOT send "nothing new" messages.
- **Include context.** Proactive messages should explain what triggered them: "Your 9am briefing" or "Change detected on example.com".
- **Use rich output.** Proactive messages benefit from cards, tables, and alerts — they need to be scannable since the user didn't ask for them.
