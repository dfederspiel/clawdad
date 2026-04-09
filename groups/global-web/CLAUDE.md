# Web UI Capabilities

These instructions apply only to agents running in the web UI. Non-web channels (Discord, Telegram, Slack) have their own formatting — don't use blocks or sound fences there.

## Rich Content Blocks

Rich content blocks (`:::blocks` fences) are available for structured output — tables, metrics, alerts, buttons, forms, and more. Full block type reference and formatting rules are in the `rich-output` skill.

## Images and Browser Snapshots

- The web UI supports inline images in the chat thread.
- If you create or inspect visual artifacts, prefer showing them to the user instead of only describing them in text.
- Use `mcp__nanoclaw__publish_browser_snapshot` to capture and publish the current browser view when visual confirmation would help.
- Use `mcp__nanoclaw__publish_media` to publish an existing image you saved under `/workspace/group/`, preferably in `/workspace/group/artifacts/` or `/workspace/group/uploads/`.
- When the user uploads an image, it may appear inline in the thread and also be available to you as a file path under `/workspace/group/uploads/`.
- Be selective. Publish screenshots when they help the user decide, verify, or debug. Avoid spamming the thread with low-value snapshots.

### Snapshot Policy

- If the user asks to "show me", "send a screenshot", "what do you see?", or anything similar, strongly prefer `mcp__nanoclaw__publish_browser_snapshot` instead of answering only in text.
- If browser work reaches a blocker or ambiguous visual state, publish one screenshot before asking the user what to do next.
- Typical blocker states include login walls, captchas, permission prompts, modal traps, confusing UI forks, missing expected controls, and obviously broken layouts.
- When publishing a blocker screenshot, include a short caption that explains what is blocking progress and what decision or confirmation you need from the user.
- Do not publish a screenshot for every browser step. One good screenshot at the right decision point is better than a stream of low-signal images.

## Sounds and Status

You can play notification sounds and set your sidebar status using MCP tools:

- `mcp__nanoclaw__play_sound` — play a named tone (e.g. `treasure`, `levelup`, `encounter`) or compose a custom sound
- `mcp__nanoclaw__set_subtitle` — set a status line under your group name (e.g. "Monitoring 3 PRs")
- `mcp__nanoclaw__set_agent_status` — set a short status line under your own agent row in the expanded sidebar (e.g. "Reviewing flags" or "Drafting summary")
- `mcp__nanoclaw__unlock_achievement` — unlock an achievement configured by the user when a meaningful milestone is reached

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
