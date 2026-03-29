---
id: browser-automation
teaches: "agent-browser for real web browsing, interaction, screenshots, data extraction"
tools: [agent-browser]
complexity: intermediate
depends_on: []
---

## Browser Automation

The `agent-browser` tool gives agents a real browser — they can navigate pages, interact with elements, take screenshots, and extract data. This works even on JavaScript-heavy sites.

### Core commands

```bash
# Open a URL
agent-browser open https://example.com

# Take a snapshot (DOM structure — good for reading content)
agent-browser snapshot

# Take a snapshot with element IDs (for clicking/filling)
agent-browser snapshot -i

# Take a screenshot (visual — good for showing the user)
agent-browser screenshot

# Click an element (use IDs from snapshot -i)
agent-browser click @e5

# Fill a form field
agent-browser fill @e3 "text to type"

# Extract text from an element
agent-browser extract @e7

# Save browser state (cookies, session)
agent-browser save-state my-session

# Load saved state
agent-browser load-state my-session
```

### Teaching pattern

When introducing browser automation, visit a page live and show the user:

> I can browse real websites just like you. Let me show you.

```bash
agent-browser open https://example.com
agent-browser screenshot
```

:::blocks
[{"type":"card","title":"Browsing: example.com","icon":"globe","body":"I can see the page. Here's what I'm looking at:\n\n[Describe key content visible]\n\nI can interact with any element — click buttons, fill forms, extract data.","footer":"Powered by agent-browser"}]
:::

### Session persistence

For sites that require login, save browser state after authentication:

```bash
agent-browser save-state my-site-login
```

On subsequent runs, load the state to skip login:

```bash
agent-browser load-state my-site-login
```

### Multi-step workflows

For complex automations, break the workflow into clear steps:

1. Open the URL
2. Take a snapshot with IDs (`snapshot -i`)
3. Interact with elements (click, fill)
4. Take a screenshot to confirm the result
5. Extract the data you need
