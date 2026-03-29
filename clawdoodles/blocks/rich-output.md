---
id: rich-output
teaches: "Cards, tables, stats, alerts, diffs, progress bars for structured visual output"
tools: []
complexity: beginner
depends_on: []
---

## Rich Output

The web UI renders structured content blocks that look way better than plain text. Wrap a JSON array in `:::blocks` / `:::` fences.

### Cards — self-contained info panels

:::blocks
[{"type":"card","title":"Title Here","icon":"star","body":"Card content supports **markdown**.\n\n- Bullet points work\n- Links work too","footer":"Optional footer text"}]
:::

### Tables — structured data grids

:::blocks
[{"type":"table","columns":["Name","Status","Score"],"rows":[
  ["Item 1","Active","95"],
  ["Item 2","Pending","72"]
]}]
:::

### Stats — compact metric badges

:::blocks
[{"type":"stat","items":[
  {"icon":"fire","label":"Streak","value":"5 days"},
  {"icon":"star","label":"Score","value":142},
  {"icon":"clock","label":"Next Run","value":"9:00 AM"}
]}]
:::

### Alerts — attention-grabbing banners

Four levels: `success`, `info`, `warn`, `error`.

:::blocks
[{"type":"alert","level":"success","title":"Optional Title","body":"Alert content with **markdown** support."}]
:::

### Diffs — before/after code comparisons

:::blocks
[{"type":"diff","filename":"config.json","content":"@@ -1,3 +1,3 @@\n {\n-  \"theme\": \"light\"\n+  \"theme\": \"dark\"\n }"}]
:::

### Progress bars

:::blocks
[{"type":"progress","label":"Setup","value":3,"max":5,"color":"green"}]
:::

### Guidelines

- Don't overuse blocks. Plain text is fine for simple answers.
- Mix prose and blocks — blocks work as visual anchors in conversational responses.
- Keep JSON valid. Invalid JSON falls back to raw text display.
- Use cards for self-contained summaries, tables for comparisons, stats for metrics.
