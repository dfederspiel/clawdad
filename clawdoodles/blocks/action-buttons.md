---
id: action-buttons
teaches: "Clickable buttons for user choices, human-in-the-loop workflows"
tools: []
complexity: beginner
depends_on: [rich-output]
---

## Action Buttons

Action buttons present clickable choices in the web UI. When clicked, they send `[action: button_id]` as a chat message back to the agent.

### Presenting choices

:::blocks
[{"type":"action","buttons":[
  {"id":"option_a","label":"Option A","style":"primary"},
  {"id":"option_b","label":"Option B","style":"default"},
  {"id":"skip","label":"Skip this","style":"default"}
]}]
:::

Button styles:
- `primary` — blue, for the recommended/main action
- `danger` — red, for destructive or irreversible actions
- `default` — gray, for secondary options

### Handling button clicks

When you receive `[action: option_a]` in a follow-up message, that's the user clicking the button. Route to the appropriate handler.

### Human-in-the-loop pattern

For workflows that need user confirmation before proceeding:

> I'm about to [describe action]. This will [explain impact].

:::blocks
[{"type":"action","buttons":[
  {"id":"confirm","label":"Go ahead","style":"primary"},
  {"id":"cancel","label":"Cancel","style":"danger"}
]}]
:::

Wait for the user's click before proceeding. Never take irreversible actions without confirmation.

### Onboarding choices

Action buttons are great during setup for multi-choice questions:

> **What kind of [thing] interests you?**

:::blocks
[{"type":"action","buttons":[
  {"id":"type_a","label":"Type A","style":"primary"},
  {"id":"type_b","label":"Type B","style":"default"},
  {"id":"type_c","label":"Type C","style":"default"},
  {"id":"custom","label":"Something else","style":"default"}
]}]
:::

### Guidelines

- Use buttons for real choices that drive the next step
- Don't use buttons for trivial things — plain text works for yes/no
- Limit to 4-5 buttons max — too many options causes decision paralysis
- Always have a "skip" or "something else" escape hatch
