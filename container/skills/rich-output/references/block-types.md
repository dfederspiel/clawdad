# Block Type Reference

Full documentation for each block type. Read this when you need to construct a specific block.

For critical syntax rules and the block protocol, see the main `rich-output` SKILL.md.

## text

Standard markdown prose. You rarely need this explicitly — text outside of `:::blocks` fences is already rendered as markdown with full support for headers, tables, bold, italic, strikethrough, links, code, checkboxes, ordered/unordered lists, and horizontal rules.

```json
{ "type": "text", "content": "## Summary\nEverything looks good." }
```

## code

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

## card

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

## table

Structured data grid. Use when presenting tabular data — cleaner than markdown tables for JSON-sourced data.

```json
{ "type": "table", "columns": ["Service", "Status", "Version"], "rows": [["api", "✅ Running", "2.4.1"], ["web", "✅ Running", "1.8.0"], ["worker", "⚠️ Degraded", "3.1.2"]] }
```

**When to use:** Comparing items, listing results, showing structured data. If the data is already in a structured form, prefer this over markdown pipe tables.

| Field | Required | Description |
|-------|----------|-------------|
| `columns` | yes | Array of column header strings |
| `rows` | yes | Array of row arrays (each row is an array of cell values) |

## stats

Key-value stat badges — game HUD style. Perfect for metrics, counters, quick status readouts.

```json
{ "type": "stats", "stats": [{ "icon": "💬", "label": "Messages", "value": 142 }, { "icon": "✅", "label": "Tasks", "value": 8 }, { "icon": "🔥", "label": "Streak", "value": "5 days" }] }
```

**When to use:** Displaying metrics, counts, quick summaries of numeric data. Each stat renders as a compact badge.

| Field | Required | Description |
|-------|----------|-------------|
| `stats` | yes | Array of `{ icon?, label, value }` objects |

## progress

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

## alert

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

## diff

Unified diff display with add/remove line coloring.

```json
{ "type": "diff", "filename": "config.ts", "content": "@@ -1,3 +1,3 @@\n const port = 3000;\n-const host = 'localhost';\n+const host = '0.0.0.0';\n const debug = false;" }
```

**When to use:** Showing code changes, before/after comparisons, patch results.

| Field | Required | Description |
|-------|----------|-------------|
| `content` | yes | Unified diff text (lines starting with `+`, `-`, `@@`) |
| `filename` | no | File being diffed |

## action

Clickable buttons the user can press. Each button can open a URL, run a specialist in a portal, or send `[action: button_id]` back into the chat. Click-handler precedence is `url` → `target: "thread"` → default chat round-trip.

```json
{ "type": "action", "buttons": [{ "id": "approve", "label": "Approve", "style": "primary" }, { "id": "reject", "label": "Reject", "style": "danger" }, { "id": "skip", "label": "Skip", "style": "default" }] }
```

URL button — opens the link in a new tab, no chat round-trip:
```json
{ "type": "action", "buttons": [{ "label": "View on GitHub", "style": "primary", "url": "https://github.com/dfederspiel/clawdad/pull/148" }] }
```

**When to use:** Presenting choices that require user input — approve/deny, pick an option, confirm an action. When you receive `[action: <id>]` in a follow-up message, that's the user clicking the button.

| Field | Required | Description |
|-------|----------|-------------|
| `id` | recommended | Stable identifier for the block. Required if you want to update the block later via `update_block`. |
| `buttons` | yes | Array of button objects (see below) |

**Button fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `label` | yes | Button text. |
| `id` | yes unless `url` is set | Identifier echoed back as `[action: id]` when the button is clicked. Not used by URL buttons. |
| `style` | no | `primary` (blue), `danger` (red), `default` (gray) |
| `url` | no | `http(s)` URL. Click opens in a new tab via `window.open(url, '_blank', 'noopener,noreferrer')`. Non-http schemes (`javascript:`, `data:`, `file:`) are rejected for safety. |
| `target` | no | `"main"` (default) or `"thread"`. `"thread"` runs the action in a portal panel instead of injecting `[action: id]` into the main chat. |
| `target_agent` | required when `target="thread"` | Name of the specialist agent the portal should run. |
| `action_message` | no | Custom prompt sent to the specialist. Defaults to the button label. |

**Pick the right click mode:**

| Goal | Use |
|------|-----|
| Navigate to an external page (PR, dashboard, docs) | `url` (or a plain markdown link) |
| Run a specialist task without flooding the main feed | `target: "thread"` + `target_agent` |
| Get user input back into the conversation | default (echoes `[action: id]`) |

**Anti-pattern — silently broken navigation buttons.** A button labelled "View on GitHub" / "Open dashboard" without a `url` will fire `[action: id]` instead of opening anything. The user sees nothing happen, you receive a dead callback, and you burn turns on a no-op. Always set `url` for navigation, or use a markdown link.

### Updating an action block

Once emitted, an action block can be updated in place via the `mcp__nanoclaw__update_block` tool. Pass the host-assigned `message_id` (read it from the `id` attribute on the `<message>` element in your conversation context) and the `block_id` you assigned at emission.

State fields the action renderer honors:

| State field | Type | Effect |
|---|---|---|
| `status` | `"idle" \| "pending" \| "done" \| "failed"` | Renders an icon badge (check / x / spinner / circle) next to the buttons. |
| `result` | string | Caption text shown below the button row. |
| `clicked_button_id` | string | Highlights the matching button with a ring. |

State is shallow-merged — only include fields that changed. Updates are persistent and survive page refresh.

Example update:
```
update_block({
  message_id: "<id from your prior <message> element>",
  block_id: "deploy-confirm",
  state: { status: "done", result: "Shipped v2.0 in 2m 14s", clicked_button_id: "ship" }
})
```

## form

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

## image

Inline image display.

```json
{ "type": "image", "src": "/api/media/group/artifacts/screenshot.png", "alt": "Screenshot" }
```

## sound

Play a notification tone inline in the message.

```json
{ "type": "sound", "tone": "treasure", "label": "Task complete!" }
```

See `global-web/CLAUDE.md` for available tones.
