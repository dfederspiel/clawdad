---
id: forms
teaches: "Interactive forms for collecting structured input — configuration, preferences, multi-field data"
tools: []
complexity: beginner
depends_on: [rich-output]
---

## Forms

Forms collect multiple pieces of information at once through a proper UI instead of asking questions one at a time. When submitted, the data comes back as a structured `[form: id]...[/form]` message.

### Basic form

:::blocks
[{"type":"form","id":"config","title":"Quick Setup","fields":[
  {"name":"name","label":"Display Name","type":"text","required":true,"placeholder":"What should I call you?"},
  {"name":"timezone","label":"Timezone","type":"select","options":["US/Eastern","US/Central","US/Mountain","US/Pacific","Europe/London","Europe/Berlin","Asia/Tokyo"]},
  {"name":"notifications","label":"Send me reminders","type":"checkbox","default":true}
],"submitLabel":"Save"}]
:::

### Handling form responses

When you receive a form response, parse the key-value pairs:

```
[form: config]
name: Alex
timezone: US/Pacific
notifications: true
[/form]
```

If the user cancels, you'll get:

```
[form: config]
cancelled: true
[/form]
```

### Field types

- `text` — single-line input (also `email`, `url`, `number`)
- `select` — dropdown menu with `options` array
- `checkbox` — boolean toggle
- `textarea` — multi-line text

Every field takes: `name`, `label`, `type`, `required`, `default`, `placeholder`, `helpText`

### When to use forms vs. action buttons

- **Forms** — collecting data (names, URLs, config values, multi-field input)
- **Action buttons** — presenting choices (approve/reject, pick one option)

### When NOT to use forms

- For secrets, API keys, or passwords — use the `request_credential` MCP tool instead
- For a single yes/no question — action buttons are simpler
- For free-form conversation — just ask in plain text

### Onboarding pattern

Forms are great for initial setup — collect everything in one shot:

:::blocks
[{"type":"form","id":"onboarding","title":"Let's get you set up","description":"I just need a few details to personalize your experience.","fields":[
  {"name":"name","label":"Your name","type":"text","required":true},
  {"name":"role","label":"What do you do?","type":"text","placeholder":"e.g. developer, designer, student"},
  {"name":"frequency","label":"How often should I check in?","type":"select","options":[
    {"value":"hourly","label":"Every hour"},
    {"value":"daily","label":"Once a day"},
    {"value":"weekly","label":"Once a week"}
  ]},
  {"name":"verbose","label":"Detailed explanations","type":"checkbox","helpText":"Turn this on if you want me to explain what I'm doing"}
],"submitLabel":"Let's go"}]
:::
