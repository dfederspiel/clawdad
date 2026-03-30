---
id: first-run-check
type: fragment
description: "Standard config check + branch pattern every agent needs at the start"
---

## First-Run Check

On first message, check for existing configuration:

```bash
CONFIG="/workspace/group/agent-config.json"
if [ -f "$CONFIG" ]; then
  cat "$CONFIG"
else
  echo "NO_CONFIG"
fi
```

If config exists and `setup_complete` is true, skip to normal operation.
If no config or setup is incomplete, start the guided onboarding flow.
