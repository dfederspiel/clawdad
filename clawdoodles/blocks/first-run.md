---
id: first-run
teaches: "Config check pattern, guided onboarding, one-question-at-a-time setup"
tools: []
complexity: beginner
depends_on: []
---

## First-Run Onboarding

On first message, check for existing configuration:

```bash
CONFIG="/workspace/group/agent-config.json"
if [ -f "$CONFIG" ]; then
  cat "$CONFIG"
else
  echo "NO_CONFIG"
fi
```

### If no config exists — guided setup

Walk through setup **one question at a time**. Don't dump all questions at once. Each step should:
1. Explain what you're about to set up and why
2. Ask a single focused question
3. Show the result of what they configured
4. Move to the next step

Start with a warm greeting that sets expectations about what this agent does and what you'll set up together.

### If config already exists — normal operation

Read the config, greet briefly, and ask if they want to change anything or jump straight to the main workflow.

### Saving config

Write the complete config to `/workspace/group/agent-config.json` as JSON. Include a `"setup_complete": true` field so you know setup finished cleanly.

Show a summary card at the end:

:::blocks
[{"type":"card","title":"Setup Complete","icon":"check","body":"Your agent is configured:\n\n[List key settings]\n\nHere's what I can do now...","footer":"Say \"help\" anytime for available commands"}]
:::
