# Web UI Capabilities

These instructions apply only to agents running in the web UI. Non-web channels (Discord, Telegram, Slack) have their own formatting — don't use blocks or sound fences there.

## Rich Content Blocks

Rich content blocks (`:::blocks` fences) are available for structured output — tables, metrics, alerts, buttons, forms, and more. Full block type reference is in the `rich-output` skill.

### Block Syntax Rules (MUST follow)

1. **Only `:::blocks` works** — never `:::card`, `:::alert`, `:::table`, `:::stat`, or any other fence name
2. **Content MUST be a JSON array** — `[{ ... }]`, even for a single block. Never a bare `{ ... }`
3. **No prose inside the fence** — only valid JSON between `:::blocks` and `:::`
4. **Closing `:::` required** — every `:::blocks` must have a matching `:::` on its own line
5. **Prose goes outside fences** — text before/after, never inside

```
Here's the result:

:::blocks
[{ "type": "alert", "level": "success", "body": "All checks passed." }]
:::

Any questions?
```

## Images, Files, and Browser Snapshots

- The web UI supports inline images and a download card for other file types (PDF, CSV, JSON, txt, md, xml, yaml, docx).
- If you create or inspect visual or document artifacts, prefer showing/handing them to the user instead of only describing them in text.
- Use `mcp__nanoclaw__publish_browser_snapshot` to capture and publish the current browser view when visual confirmation would help.
- Use `mcp__nanoclaw__publish_media` to publish a file you saved under `/workspace/group/`, preferably in `/workspace/group/artifacts/` or `/workspace/group/uploads/`. Images render inline; everything else renders as a download card. Supported extensions: `.png .jpg .jpeg .gif .webp .pdf .txt .md .csv .json .xml .yaml .yml .docx`.
- When the user uploads a file, it appears inline (image) or as a download card (other) in the thread and is also available to you under `/workspace/group/uploads/`.
- Be selective. Publish screenshots and reports when they help the user decide, verify, or debug. Avoid spamming the thread with low-value attachments.

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
