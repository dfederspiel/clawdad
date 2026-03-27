---
name: discord-formatting
description: Format messages for Discord using its supported markdown subset. Use when responding to Discord channels (folder starts with "discord_" or JID starts with "dc:").
---

# Discord Message Formatting

When responding to Discord channels, use only Discord's supported markdown. Discord uses a subset of standard markdown — some common features (tables, image markdown) do NOT render.

## How to detect Discord context

Check your group folder name or JID:
- Folder starts with `discord_` (e.g., `discord_deployments`)
- Or JID starts with `dc:` (e.g., `dc:1486501882540326952`)

## Supported formatting (use these)

### Text styles

| Style | Syntax | Notes |
|-------|--------|-------|
| Bold | `**text**` | Primary emphasis |
| Italic | `*text*` | Secondary emphasis |
| Underline | `__text__` | Available but bold preferred |
| Bold italic | `***text***` | For strong emphasis |
| Strikethrough | `~~text~~` | |
| Code (inline) | `` `code` `` | For ticket IDs, paths, functions |
| Code block | ` ```code``` ` | Multi-line code or logs |
| Syntax highlight | ` ```js\ncode\n``` ` | Language-specific highlighting |
| Spoiler | `\|\|text\|\|` | Hidden until clicked |

### Headers

```
# Large heading
## Medium heading
### Small heading
```

Headers work in Discord — use them for section breaks in longer messages.

### Quotes

```
> Single-line blockquote
>>> Multi-line blockquote
(everything after >>> is quoted)
```

### Lists

```
- Bullet point
- Another bullet
  - Nested bullet

1. Numbered item
2. Another item
```

### Links

```
[Link text](https://example.com)     # Masked link
https://example.com                   # Auto-linked URL
```

**Always use masked links for Jira tickets:**
```
[POLUIG-1234](https://blackduck.atlassian.net/browse/POLUIG-1234)
```

### Timestamps

Discord renders Unix timestamps natively:
```
<t:1679616000:R>  → "2 hours ago" (relative)
<t:1679616000:f>  → "March 24, 2023 12:00 PM" (full)
<t:1679616000:D>  → "March 24, 2023" (date only)
```

## NOT supported (never use these)

- **Tables** — `| col | col |` renders as raw text, not a table
- **Image markdown** — `![alt](url)` does not embed images
- **Footnotes** — not supported
- **HTML tags** — stripped or ignored
- **Horizontal rules** — `---` does not render as a line

## Known gotcha: bold + links

**Never nest a link inside bold markers.** When Discord wraps a long line, the closing `**` lands on a different line and bold breaks.

Bad (breaks on wrap):
```
**New Bug: [POLUIG-1234](https://blackduck.atlassian.net/browse/POLUIG-1234)**
```

Good (bold closes before link):
```
**New Bug:** [POLUIG-1234](https://blackduck.atlassian.net/browse/POLUIG-1234)
```

Rule: close `**bold**` before any `[link](url)`. Put the link after the bold label.

## Emoji

Use Unicode emoji directly (not shortcodes):
- 🔴 🟡 🟢 ⚪ — status/severity indicators
- ✅ ❌ ⚠️ — success/failure/warning
- 🔧 🔍 🚨 — action types
- 📋 📌 🔗 — organizational
- 🚀 🎉 — celebrations

## Example message

```
🔴 **New Bug:** [POLUIG-1234](https://blackduck.atlassian.net/browse/POLUIG-1234)
**Created:** 2026-03-25 · **Assignee:** Unassigned · **Reporter:** Jane Smith
> Dashboard widget fails to load when user has no projects assigned.
> TypeError: Cannot read properties of undefined (reading 'map')

🔍 **Triage:** Suspected null check missing in `packages/dashboard/src/widgets/ProjectList.tsx`
**Confidence:** High · **Suggested assignee:** Dylan Halperin (recent commits in this area)

✅ Jira comment posted · Label added
```

## Quick rules

1. Use `**bold**` (double asterisks) — not `*single*` (that's italic in Discord)
2. Use `[text](url)` for links — works in regular messages
3. **Never nest links inside bold** — close `**` before the `[link](url)`
4. Use `-` or `1.` for lists — both work
5. Use `#` headers for section breaks
6. Use `>` for quoting bug descriptions
7. **Never use tables** — use bullet lists or bold labels instead
8. Use emoji sparingly for visual scanning — severity colors, action icons
9. One message per distinct topic — don't batch unrelated items
