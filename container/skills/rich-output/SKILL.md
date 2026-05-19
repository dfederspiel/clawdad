---
name: rich-output
description: Rich content blocks for the ClawDad web UI. Use when responding to web channels (folder starts with "web_") to emit structured blocks — code, cards, tables, stats, progress bars, diffs, alerts, and action buttons — alongside standard markdown.
---

# Rich Output — Web UI Content Blocks

## CRITICAL: Block Syntax Rules

These 5 rules are non-negotiable. Violations render as broken JSON in the chat.

1. **Only `:::blocks` works** — never use `:::card`, `:::alert`, `:::table`, `:::stat`, or any other fence name
2. **Content MUST be a JSON array** — `[{ ... }]`, even for a single block. Never a bare `{ ... }` object
3. **No prose inside the fence** — only valid JSON between `:::blocks` and `:::`
4. **Closing `:::` required** — every `:::blocks` must have a matching `:::` on its own line
5. **Prose goes outside fences** — text before/after the fence, never inside it

## Block Protocol

Wrap a JSON array in `:::blocks` / `:::` fences. Mix prose and block fences freely.

```
Here's what I found:

:::blocks
[
  { "type": "alert", "level": "success", "body": "All checks passed." }
]
:::

Let me know if you want details.
```

Plain markdown still works — use blocks only when they add clarity or visual value.

**Web only:** If the channel is NOT web (Slack, Discord, Telegram), do NOT use blocks — they render as raw JSON.

## Block Type Quick Reference

For full documentation with JSON examples and field tables: `Read references/block-types.md`

| Type | Key Fields | Use for |
|------|-----------|---------|
| `text` | `content` | Markdown prose (rarely needed — text outside fences is already markdown) |
| `code` | `content`, `language?`, `filename?` | Code snippets with syntax highlighting and copy button |
| `card` | `title`, `body`, `icon?`, `footer?`, `rows?`, `status?` | Status reports, summaries, self-contained info panels |
| `table` | `columns`, `rows` | Structured data grids (cleaner than markdown tables) |
| `stats` | `stats: [{ icon?, label, value }]` | Metric badges, counters, quick readouts |
| `progress` | `label`, `value`, `max`, `color?` | Task completion, build progress |
| `alert` | `level` (success/warn/error/info), `body`, `title?` | Important status changes, errors, warnings |
| `diff` | `content`, `filename?` | Unified diffs with colored add/remove lines |
| `action` | `buttons: [{ id, label, style?, url? }]` | Clickable buttons — open a URL, run a portal specialist, or send `[action: id]` |
| `form` | `id`, `fields`, `title?`, `submitLabel?` | Multi-field input collection — submits send `[form: id]` |
| `image` | `src`, `alt?` | Inline images |
| `sound` | `tone`, `label?` | Notification tones |

## Combining Blocks

**When to use:** Sharing code snippets, file contents, command output, configs. Prefer this over triple-backtick markdown fences when you want the filename badge or when the code is a standalone artifact (not inline in prose).

| Field | Required | Description |
|-------|----------|-------------|
| `content` | yes | The code string |
| `language` | no | Language for syntax highlighting (e.g., `typescript`, `python`, `bash`, `json`) |
| `filename` | no | Filename shown as a badge in the header |

### card
Titled panel for structured information — status reports, summaries, feature descriptions. Supports both free-form markdown (`body`) and structured key-value data (`rows`).

```json
{ "type": "card", "title": "Deployment Status", "icon": "🚀", "body": "All 3 services deployed successfully.\n\n- **api**: v2.4.1\n- **web**: v1.8.0\n- **worker**: v3.1.2", "footer": "Deployed 2 minutes ago" }
```

With structured rows and a status indicator:
```json
{ "type": "card", "title": "Triage Run", "status": "success", "rows": [{ "label": "New Bugs", "value": "0" }, { "label": "Open PRs", "value": "1" }] }
```

**When to use:** Presenting a self-contained summary, status update, or info block that benefits from visual framing. Use `body` for markdown prose, `rows` for key-value data, or both.

| Field | Required | Description |
|-------|----------|-------------|
| `title` | yes | Card header text |
| `icon` | no | Emoji or short string shown before the title |
| `body` | one of `body` or `rows` | Card content (supports markdown). `content` is accepted as an alias. |
| `rows` | one of `body` or `rows` | Array of `{ label, value }` objects rendered as a key-value list |
| `status` | no | Colored dot on the header: `success` (green), `warn` (yellow), `error` (red), `info` (blue) |
| `footer` | no | Muted text at the bottom |

### table
Structured data grid. Use when presenting tabular data — cleaner than markdown tables for JSON-sourced data.

```json
{ "type": "table", "columns": ["Service", "Status", "Version"], "rows": [["api", "✅ Running", "2.4.1"], ["web", "✅ Running", "1.8.0"], ["worker", "⚠️ Degraded", "3.1.2"]] }
```

**When to use:** Comparing items, listing results, showing structured data. If the data is already in a structured form, prefer this over markdown pipe tables.

| Field | Required | Description |
|-------|----------|-------------|
| `columns` | yes | Array of column header strings |
| `rows` | yes | Array of row arrays (each row is an array of cell values) |

### stats
Key-value stat badges — game HUD style. Perfect for metrics, counters, quick status readouts.

```json
{ "type": "stats", "stats": [{ "icon": "💬", "label": "Messages", "value": 142 }, { "icon": "✅", "label": "Tasks", "value": 8 }, { "icon": "🔥", "label": "Streak", "value": "5 days" }] }
```

**When to use:** Displaying metrics, counts, quick summaries of numeric data. Each stat renders as a compact badge.

| Field | Required | Description |
|-------|----------|-------------|
| `stats` | yes | Array of `{ icon?, label, value }` objects |

### progress
Progress bar — for task completion, XP, build progress, deployment stages.

```json
{ "type": "progress", "label": "Build", "value": 7, "max": 10, "color": "green" }
```

**When to use:** Showing completion status, progress through a sequence, resource usage.

| Field | Required | Description |
|-------|----------|-------------|
| `label` | yes | What is being measured |
| `value` | yes | Current value |
| `max` | yes | Maximum value |
| `color` | no | `gold`, `green`, `blue`, `red`, `purple` (default: `gold`) |

### alert
Banners for success, warning, error, or info messages. Eye-catching, color-coded.

```json
{ "type": "alert", "level": "warn", "title": "Rate limit approaching", "body": "API usage at 85% of daily quota. Consider spacing out requests." }
```

**When to use:** Important status changes, errors, warnings, success confirmations — anything that deserves visual emphasis.

| Field | Required | Description |
|-------|----------|-------------|
| `level` | yes | `success`, `warn`, `error`, `info` |
| `title` | no | Bold header text |
| `body` | yes | Alert content (supports markdown) |

### diff
Unified diff display with add/remove line coloring.

```json
{ "type": "diff", "filename": "config.ts", "content": "@@ -1,3 +1,3 @@\n const port = 3000;\n-const host = 'localhost';\n+const host = '0.0.0.0';\n const debug = false;" }
```

**When to use:** Showing code changes, before/after comparisons, patch results.

| Field | Required | Description |
|-------|----------|-------------|
| `content` | yes | Unified diff text (lines starting with `+`, `-`, `@@`) |
| `filename` | no | File being diffed |

### action
Clickable buttons the user can press. Each button can open a URL, run a specialist in a portal, or send `[action: button_id]` back into the chat.

```json
{ "type": "action", "buttons": [{ "id": "approve", "label": "Approve", "style": "primary" }, { "id": "reject", "label": "Reject", "style": "danger" }, { "id": "skip", "label": "Skip", "style": "default" }] }
```

**When to use:** Presenting choices that require user input — approve/deny, pick an option, confirm an action. When you receive `[action: <id>]` in a follow-up message, that's the user clicking the button.

| Field | Required | Description |
|-------|----------|-------------|
| `buttons` | yes | Array of `{ id, label, style?, url?, target?, target_agent?, action_message? }` objects |
| `id` | yes unless `url` is set | Identifier echoed back as `[action: id]` when the button is clicked. Not used when `url` is set. |
| `style` | no | `primary` (blue), `danger` (red), `default` (gray) |
| `url` | no | `http(s)` URL. Click opens it in a new tab (`noopener,noreferrer`); no chat round-trip. Non-http schemes are rejected. |
| `target` | no | `"main"` (default — click sends a user message in chat) or `"thread"` (click runs a specialist agent in a side-panel portal instead of cluttering the main feed). Use for "run a focused task" actions like "Review PR #1310" or "Regenerate weekly report". |
| `target_agent` | required when `target="thread"` | Name of the specialist agent that should handle this action. The portal drains that agent's output. |
| `action_message` | no | Custom prompt sent to the target agent. Defaults to the button label. Prefer an explicit, specific prompt so the specialist has the context it needs. |

**Pick the right click mode** — precedence is `url` → `target: "thread"` → default:

| Goal | Use |
|------|-----|
| Open an external page (GitHub PR, dashboard, docs) | `url` field (or a markdown link if the visual emphasis of a button isn't needed) |
| Run a focused specialist task without flooding the main feed | `target: "thread"` + `target_agent` |
| Get user input back into the conversation (approve/reject/pick) | default — clicks send `[action: id]` |

**Anti-pattern:** a navigation-styled button without `url` is silently broken. If the label reads like "View on GitHub" / "Open dashboard" / "View build" and there's no `url`, the click fires `[action: id]` and you have to handle a dead round-trip. Either set `url`, or use a markdown link instead of a button.

**Portal button example** — dashboard with drill-in actions that don't bury the status report:

```json
{ "type": "action", "buttons": [
  { "id": "review_1310", "label": "Review PR #1310", "style": "primary", "target": "thread", "target_agent": "reviewer", "action_message": "Review PR #1310 in detail — check the diff, call out any risky changes, and flag files that look off." },
  { "id": "skip", "label": "Skip", "style": "default" }
] }
```

## Updating blocks after emission

You can update a previously-emitted block *in place* — change a button's status to "Done", advance a progress bar, replace a stale stat. This lets you close the loop on actions instead of emitting a new message every time something changes.

**Two requirements:**
1. Give the block an explicit `id` field when you emit it. Blocks without an `id` are not addressable.
2. Call `mcp__nanoclaw__update_block({ message_id, block_id, state })` later, passing the host-assigned id of the bot message that contained the block.

**Finding the message_id:** every message in your conversation context carries an `id` attribute on the `<message>` element — your own prior outputs included. To update a block you emitted in a previous turn, read the id from that XML attribute.

**Example flow:**

Turn 1 — emit a block with an id:
```
:::blocks
[{ "type": "action", "id": "deploy-confirm", "buttons": [{ "id": "ship", "label": "Ship" }] }]
:::
```

Turn 2 — the deploy completed, mark the block done:
```
update_block({
  message_id: "<id from your turn-1 <message> element>",
  block_id: "deploy-confirm",
  state: { status: "done", result: "Shipped v2.0 in 2m 14s", clicked_button_id: "ship" }
})
```

**State is shallow-merged** over the block payload — only send fields that changed. State stays attached to the message forever; refreshes preserve it.

**Action block state contract** (other block types accept the same `state` object but renderer support is narrower in Phase 1):

| Field | Effect |
|-------|--------|
| `status` | `"idle" \| "pending" \| "done" \| "failed"` — renders an icon badge next to the buttons |
| `result` | Caption text shown below the button row |
| `clicked_button_id` | Highlights the matching button |

**When to update vs. emit a new message:** update when the *same surface* should reflect a new value (button → done, progress 30% → 60%, card body refreshed). Emit a new message when there's genuinely new content to deliver.

### form
Interactive form for collecting structured input from the user. Renders as labeled fields with a submit button. When submitted, sends a structured `[form: id]...[/form]` message back to you.

```json
{ "type": "form", "id": "project-setup", "title": "Project Configuration", "fields": [{ "name": "repo_url", "label": "Repository URL", "type": "text", "required": true, "placeholder": "https://github.com/..." }, { "name": "environment", "label": "Environment", "type": "select", "options": ["dev", "staging", "prod"] }, { "name": "auto_deploy", "label": "Enable auto-deploy", "type": "checkbox" }, { "name": "notes", "label": "Additional notes", "type": "textarea" }], "submitLabel": "Configure" }
```

**When to use:** Collecting multiple pieces of non-secret information at once — configuration, preferences, project details, onboarding data. Much better UX than asking questions one at a time. For secrets (API keys, tokens), use the credential popup instead.

When submitted, you'll receive a message like:
```
[form: project-setup]
repo_url: https://github.com/user/repo
environment: staging
auto_deploy: true
notes: Use the beta branch
[/form]
```

If the user cancels:
```
[form: project-setup]
cancelled: true
[/form]
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique identifier — used in the response tag |
| `title` | no | Header text above the form |
| `description` | no | Muted help text below the title |
| `fields` | yes | Array of field objects (see below) |
| `submitLabel` | no | Submit button text (default: "Submit") |
| `cancelLabel` | no | Cancel button text (default: "Cancel", set to `false` to hide) |

**Field types:**

| Type | Description | Extra fields |
|------|-------------|-------------|
| `text` | Single-line text input | `placeholder` |
| `email` | Email input with validation | `placeholder` |
| `url` | URL input with validation | `placeholder` |
| `number` | Numeric input | `placeholder` |
| `select` | Dropdown menu | `options` (array of strings or `{ value, label }` objects) |
| `checkbox` | Boolean toggle | — |
| `textarea` | Multi-line text | `placeholder` |

**Common field properties:** `name` (required), `label` (required), `type`, `required`, `default`, `placeholder`, `helpText`

## Combining blocks

You can include multiple blocks in one fence, and interleave fences with prose:

```
I've analyzed your deployment:

:::blocks
[
  { "type": "alert", "level": "success", "body": "Deployment completed." },
  { "type": "table", "columns": ["Service", "Version", "Status"], "rows": [["api", "2.4.1", "✅"], ["web", "1.8.0", "✅"]] },
  { "type": "stats", "stats": [{ "icon": "⏱️", "label": "Duration", "value": "3m 42s" }, { "icon": "📦", "label": "Images", "value": 2 }] }
]
:::

Want me to run the smoke tests?

:::blocks
[
  { "type": "action", "buttons": [{ "id": "run_tests", "label": "Run Tests", "style": "primary" }, { "id": "skip", "label": "Skip", "style": "default" }] }
]
:::
```

## Common Mistakes

1. **Bare objects without `[...]` wrapper** — Always wrap in an array, even for one block
2. **Using `:::card` or `:::alert` instead of `:::blocks`** — Only `:::blocks` is the correct fence name
3. **Mixing prose and JSON inside the same fence** — Prose goes OUTSIDE the `:::blocks` fence
4. **Forgetting the closing `:::`** — Every `:::blocks` must have a matching `:::` on its own line
5. **Broken markdown links inside blocks** — Use `[Title](url)` not `*[Title (url)*`
6. **Invalid JSON** — Missing commas, trailing commas, unquoted keys, unescaped newlines in strings

## Field Naming

- **`body` and `content` are interchangeable** on all block types. Use whichever feels natural.
- **Array fields are named after what they contain:** `stats`, `buttons`, `fields`, `rows`, `columns`.

## Guidelines

1. **Don't overuse blocks.** A simple text answer doesn't need blocks. Use them when structure adds value.
2. **Mix prose and blocks.** Blocks work best as visual anchors within a conversational response, not as a replacement for explanation.
3. **Keep JSON valid.** Invalid JSON falls back to plain text rendering — the user sees raw JSON.
4. **Action buttons are for real choices.** Don't present actions for trivial things.
5. **Cards for self-contained info.** If the content makes sense as a standalone panel with a title, use a card.
6. **One alert per concern.** Don't stack 5 alerts — combine related info into a single alert.
