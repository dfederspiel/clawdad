# Web UI Capabilities

These instructions apply only to agents running in the web UI. Non-web channels (Discord, Telegram, Slack) have their own formatting — don't use blocks or sound fences there.

## Rich Content Blocks

The web UI renders structured content blocks. Use them to make responses visual and scannable — tables, metrics, alerts, and interactive elements are all better as blocks than plain text.

Wrap a JSON array in `:::blocks` / `:::` fences. You can mix prose and block fences freely in the same message.

```
Here's what I found:

:::blocks
[
  { "type": "alert", "level": "success", "body": "All checks passed." },
  { "type": "stat", "items": [{ "label": "Tests", "value": "142" }, { "label": "Duration", "value": "38s" }] }
]
:::

Let me know if you want to proceed.
```

**Available block types:**

| Block | When to use | Key fields |
|-------|-------------|------------|
| `alert` | Status messages, warnings, errors, success confirmations | `level`: `success`, `warn`, `error`, `info`; `body` |
| `table` | 3+ rows of structured data — tickets, comparisons, status lists | `columns`, `rows` |
| `stat` | Metrics at a glance — counts, durations, costs | `items`: array of `{ label, value }` |
| `card` | Self-contained summaries with a title and body | `title`, `body` |
| `progress` | Step-by-step progress through a workflow | `steps`: array of `{ label, status }` |
| `action` | Buttons for user choices — approve/reject, create/skip | `buttons`: array of `{ label, action }` |
| `form` | Collect multiple inputs at once | `fields`: array of `{ name, type, label }` |
| `code` | Code snippets, logs, config with syntax highlighting | `code`, `language`, `filename` |
| `diff` | Before/after comparisons | `before`, `after` |

**When to use blocks vs prose:**
- **Use blocks** for: data tables, metrics, status readouts, pipeline results, decision points, code/logs
- **Use prose** for: explanations, conversational replies, short answers, reasoning
- **Mix both** freely — lead with a sentence, drop a block, continue in prose
- Don't force everything into blocks. A one-line answer doesn't need a `card`.

## Sounds and Status

You can play notification sounds and set your sidebar status using MCP tools:

- `mcp__nanoclaw__play_sound` — play a named tone (e.g. `treasure`, `levelup`, `encounter`) or compose a custom sound
- `mcp__nanoclaw__set_subtitle` — set a status line under your group name (e.g. "Monitoring 3 PRs")

You can also embed sounds inline in your message output:
```
:::sound
{"tone": "treasure", "label": "Task complete!"}
:::
```

**Available tones:** chime, droplet, whisper, dewdrop, bubble, ping, sparkle, twinkle, coin, bell, melody, harp, celeste, marimba, doorbell, lullaby, pulse, click, radar, sonar, tap, treasure, secret, powerup, levelup, oneup, gameover, encounter, glow, breeze, aurora.

Use sounds sparingly and meaningfully — to signal completion, errors, or attention-needed moments. Don't spam them.

## Credential Popup

When you need credentials, use `mcp__nanoclaw__request_credential` which opens a secure popup in the user's browser. See the global defaults for full credential usage instructions — always use `api.sh` for authenticated API calls.
