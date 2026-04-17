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
| `card` | `title`, `body`, `icon?`, `footer?` | Status reports, summaries, self-contained info panels |
| `table` | `columns`, `rows` | Structured data grids (cleaner than markdown tables) |
| `stat` | `items: [{ icon?, label, value }]` | Metric badges, counters, quick readouts |
| `progress` | `label`, `value`, `max`, `color?` | Task completion, build progress |
| `alert` | `level` (success/warn/error/info), `body`, `title?` | Important status changes, errors, warnings |
| `diff` | `content`, `filename?` | Unified diffs with colored add/remove lines |
| `action` | `buttons: [{ id, label, style? }]` | Clickable buttons — user clicks send `[action: id]` |
| `form` | `id`, `fields`, `title?`, `submitLabel?` | Multi-field input collection — submits send `[form: id]` |
| `image` | `src`, `alt?` | Inline images |
| `sound` | `tone`, `label?` | Notification tones |

## Combining Blocks

Multiple blocks in one fence, interleaved with prose:

```
I've analyzed your deployment:

:::blocks
[
  { "type": "alert", "level": "success", "body": "Deployment completed." },
  { "type": "table", "columns": ["Service", "Version", "Status"], "rows": [["api", "2.4.1", "✅"], ["web", "1.8.0", "✅"]] },
  { "type": "stat", "items": [{ "icon": "⏱️", "label": "Duration", "value": "3m 42s" }, { "icon": "📦", "label": "Images", "value": 2 }] }
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

## Guidelines

1. **Don't overuse blocks.** A simple text answer doesn't need blocks. Use them when structure adds value.
2. **Mix prose and blocks.** Blocks work best as visual anchors within a conversational response, not as a replacement for explanation.
3. **Keep JSON valid.** Invalid JSON falls back to plain text rendering — the user sees raw JSON.
4. **Action buttons are for real choices.** Don't present actions for trivial things.
5. **Cards for self-contained info.** If the content makes sense as a standalone panel with a title, use a card.
6. **One alert per concern.** Don't stack 5 alerts — combine related info into a single alert.
