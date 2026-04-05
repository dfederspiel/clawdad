# Web UI Capabilities

These instructions apply only to agents running in the web UI. Non-web channels (Discord, Telegram, Slack) have their own formatting — don't use blocks or sound fences there.

## Rich Content Blocks

Rich content blocks (`:::blocks` fences) are available for structured output — tables, metrics, alerts, buttons, forms, and more. Full block type reference and formatting rules are in the `rich-output` skill.

## Sounds and Status

You can play notification sounds and set your sidebar status using MCP tools:

- `mcp__nanoclaw__play_sound` — play a named tone (e.g. `treasure`, `levelup`, `encounter`) or compose a custom sound
- `mcp__nanoclaw__set_subtitle` — set a status line under your group name (e.g. "Monitoring 3 PRs")
- `mcp__nanoclaw__set_agent_status` — set a short status line under your own agent row in the expanded sidebar (e.g. "Reviewing flags" or "Drafting summary")

When you start meaningful ongoing work, prefer setting one of these statuses so the sidebar reflects what you're doing. Clear it with an empty string when the work is done.

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
