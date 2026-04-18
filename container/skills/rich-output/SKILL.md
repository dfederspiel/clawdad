---
name: rich-output
description: Rich content blocks for the ClawDad web UI. Use when responding to web channels (folder starts with "web_") to emit structured blocks — code, cards, tables, stats, progress bars, diffs, alerts, and action buttons — alongside standard markdown.
---

# Rich Output — Web UI Content Blocks

When responding through the **web UI** (group folder starts with `web_`), you can emit structured content blocks that render as rich, interactive components instead of plain text.

## How to detect web context

Check your group folder name or workspace path:
- Folder starts with `web_` (e.g., `web_main`, `web_dev`)
- Or check `/workspace/group/` path for `web_` prefix

**If the channel is NOT web (e.g., WhatsApp, Telegram, Slack, Discord):** do NOT use `:::blocks` — stick to plain markdown or the channel's native formatting. Blocks render as raw JSON in non-web channels.

## Block protocol

Wrap a JSON array in `:::blocks` / `:::` fences within your normal response. You can mix prose and block fences freely — they interleave.

```
Here's what I found:

:::blocks
[
  { "type": "alert", "level": "success", "body": "All checks passed." }
]
:::

Let me know if you want details.
```

Plain markdown still works perfectly — use blocks only when they add clarity or visual value. Don't force everything into blocks.

## Block types

### text
Standard markdown prose. You rarely need this explicitly — text outside of `:::blocks` fences is already rendered as markdown with full support for headers, tables, bold, italic, strikethrough, links, code, checkboxes, ordered/unordered lists, and horizontal rules.

```json
{ "type": "text", "content": "## Summary\nEverything looks good." }
```

### code
Syntax-highlighted code with a copy button and optional filename badge.

```json
{ "type": "code", "language": "typescript", "filename": "handler.ts", "content": "export function handle(req: Request) {\n  return new Response('ok');\n}" }
```

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
Clickable buttons the user can press. Clicking sends `[action: button_id]` as a chat message back to you.

```json
{ "type": "action", "buttons": [{ "id": "approve", "label": "Approve", "style": "primary" }, { "id": "reject", "label": "Reject", "style": "danger" }, { "id": "skip", "label": "Skip", "style": "default" }] }
```

**When to use:** Presenting choices that require user input — approve/deny, pick an option, confirm an action. When you receive `[action: <id>]` in a follow-up message, that's the user clicking the button.

| Field | Required | Description |
|-------|----------|-------------|
| `buttons` | yes | Array of `{ id, label, style? }` objects |
| `style` | no | `primary` (blue), `danger` (red), `default` (gray) |

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
I've analyzed your deployment. Here's the summary:

:::blocks
[
  { "type": "alert", "level": "success", "body": "Deployment completed successfully." },
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

## Critical: always use a JSON array

The content inside `:::blocks` **MUST** be a JSON array (`[...]`), even for a single block. This is the most common mistake.

```
✅ CORRECT — array with one item:
:::blocks
[{ "type": "card", "title": "Status", "body": "All good." }]
:::

✅ CORRECT — array with multiple items:
:::blocks
[
  { "type": "alert", "level": "success", "body": "Deployed." },
  { "type": "stats", "stats": [{ "label": "Duration", "value": "2m" }] }
]
:::

❌ WRONG — bare object (no array):
:::blocks
{ "type": "card", "title": "Status", "body": "All good." }
:::

❌ WRONG — multiple objects without array wrapping:
:::blocks
{ "type": "alert", "level": "success", "body": "Deployed." }
{ "type": "stats", "stats": [{ "label": "Duration", "value": "2m" }] }
:::
```

## Common mistakes to avoid

1. **Bare objects without `[...]` wrapper** — Always wrap in an array, even for one block.
2. **Broken markdown links inside blocks** — Use `[Title](url)` not `*[Title (url)*`. Block body fields support standard markdown.
3. **Mixing blocks and prose inside the same fence** — Prose goes OUTSIDE the `:::blocks` fence. Inside is JSON only.
4. **Forgetting the closing `:::`** — Every `:::blocks` must have a matching `:::` on its own line.

## Field Naming

- **`body` and `content` are interchangeable** on all block types. Use whichever feels natural.
- **Array fields are named after what they contain:** `stats`, `buttons`, `fields`, `rows`, `columns`.

## Guidelines

1. **Don't overuse blocks.** A simple text answer doesn't need blocks. Use them when structure adds value.
2. **Mix prose and blocks.** Blocks work best as visual anchors within a conversational response, not as a replacement for explanation.
3. **Keep JSON valid.** Invalid JSON inside `:::blocks` falls back to plain text rendering — the UI won't crash, but the user sees raw JSON.
4. **Action buttons are for real choices.** Don't present actions for trivial things. Use them when the user's decision drives your next step.
5. **Cards for self-contained info.** If the content makes sense as a standalone panel with a title, use a card. If it's part of a flowing explanation, use regular prose.
6. **One alert per concern.** Don't stack 5 alerts — combine related info into a single alert with a clear level.
