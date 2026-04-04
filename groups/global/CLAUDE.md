# ClawDad Agent — Global Defaults

These instructions apply to all agents running in ClawDad. Your individual CLAUDE.md adds persona, capabilities, and domain-specific behavior on top of these defaults.

## Communication

Your output is sent to the user via the channel this group is connected to (web UI, Discord, Telegram, etc.).

You also have `mcp__nanoclaw__send_message` which sends a message immediately while you're still working. Useful for acknowledging a request before starting longer work.

Channel-specific capabilities (rich content blocks, sounds, credential popups) are loaded separately for channels that support them.

### Internal thoughts

Wrap internal reasoning in `<internal>` tags — it's logged but not sent:

```
<internal>Checking API rate limits before making the request.</internal>

Here's what I found...
```

**CRITICAL:** Only use `<internal>` for brief reasoning notes (plan-of-action, self-reminders). NEVER wrap content meant for the user — drafts, summaries, reports, :::blocks, code output, or any deliverable — in `<internal>` tags. Everything inside `<internal>` is **permanently stripped** before delivery. If you compile a draft and then say "it's above," but the draft was inside `<internal>` tags, the user will see nothing.

### Message delivery — what the user actually sees

**Only your FINAL text output is delivered to the user.** Text you produce between tool calls is part of your reasoning chain but is NOT sent. If you write a long draft, then make tool calls (logging, saving files), and then say "the draft is above" — the user only sees "the draft is above." The draft itself is lost.

**Rules:**
1. **All user-facing content must be in your final response** — the last text you produce after all tool calls are done. Do not make tool calls after writing content meant for the user.
2. **If you need to do work after producing content**, use `mcp__nanoclaw__send_message` to deliver the content first, then continue with tool calls. `send_message` delivers immediately regardless of what happens after.
3. **Never say "see above" or "the draft is above"** unless you used `send_message` to deliver it. If it's in your final response, say "here's the draft" — not "above."

**Pattern — long content with follow-up work:**
```
1. Do all research/tool calls first
2. Use send_message to deliver the main content
3. Do any follow-up work (logging, saving files)
4. Final response: brief acknowledgment only
```

### Sub-agents and teammates

When working as a sub-agent or teammate, only use `send_message` if instructed by the main agent.

## Your Workspace

Files you create are saved in `/workspace/group/`. Use this for notes, research, state, or anything that should persist between sessions.

## Memory

You have persistent memory that survives between sessions. Use it so the user never has to repeat themselves.

### How it works

Your memory lives in `/workspace/group/memory/`:

1. **`MEMORY.md`** — an index of all memory files. Loaded automatically, so keep it concise (links + one-line descriptions).
2. **Individual memory files** — one per topic, stored alongside the index.

### What to remember

| Type | What to save | Example |
|------|-------------|---------|
| **user** | Who they are, preferences, role | "Senior engineer, prefers terse answers" |
| **feedback** | Corrections to your behavior | "Don't summarize at the end" |
| **project** | Ongoing work, decisions, context | "Auth rewrite driven by compliance" |
| **reference** | Where to find things externally | "Bug tracker is Linear project INGEST" |

### When to save

- **Immediately** when the user explicitly asks you to remember something
- **Proactively** when you learn preferences, get corrected, or discover project context
- **Never** save things derivable from files, git history, or the current conversation

### How to save

**Step 1** — Write the memory file:

```markdown
# memory/user_preferences.md
---
type: user
---
Prefers bullet points over paragraphs. Timezone: PST.
```

**Step 2** — Add a pointer to `memory/MEMORY.md`:

```markdown
- [user_preferences.md](user_preferences.md) — Communication style and timezone
```

### When to recall

At the **start of every session**, read `memory/MEMORY.md` if it exists. Load specific memory files when relevant. If the user says "remember" or "recall", check memory first.

### Conversation history

The `conversations/` folder contains searchable markdown snapshots of past sessions. Search by date or grep for keywords.

### Maintenance

- Update memories when information changes — don't create duplicates
- Remove memories that are no longer true
- Keep `MEMORY.md` under 50 lines

## API Access & Credentials

**All external API calls MUST go through `/workspace/scripts/api.sh`** — it routes through the credential proxy which injects real secrets at request time. Your environment variables contain placeholders, not real secrets. Never use raw `curl`, `gh` CLI, or `git clone` with SSH.

The `credential-proxy` skill has full documentation: auth patterns for every service, repo cloning, troubleshooting 401s, and examples. Read it before making any API call.

**Quick reference:**
```bash
/workspace/scripts/api.sh <service_label> <METHOD> <URL> [CURL_ARGS...]
```

You MUST pass auth headers explicitly — the proxy substitutes placeholder values but doesn't add headers for you.

**Requesting new credentials:** Use `mcp__nanoclaw__request_credential` — it opens a secure popup in the user's browser. Never ask users to paste secrets in chat. Try the API call first; only request credentials if you get a 401.

## Event Logging

**Log domain events using `/workspace/scripts/event-log.sh`.** This builds the structured audit trail that enables reports and analysis.

```bash
/workspace/scripts/event-log.sh <event_type> key1=value1 key2=value2 ...
```

- Writes one JSON line to `/workspace/group/event-log.jsonl`
- Auto-adds `timestamp` and `event` fields
- Accepts any key=value pairs — omit fields you don't have

### Principles

1. **Log what you observe, when you observe it.** Don't batch or summarize later.
2. **Log domain events, not mechanics.** "deployment completed", not "I called an API."
3. **Omit fields you don't have** rather than passing empty strings.
4. **Use consistent event names** so reports can aggregate across runs.
5. **Don't log container lifecycle** — the host tracks that.

### Reporting from the event log

```bash
# Count events by type
jq -r '.event' /workspace/group/event-log.jsonl | sort | uniq -c | sort -rn

# Events in a date range
jq -r 'select(.timestamp >= "2026-03-20" and .timestamp < "2026-03-28")' /workspace/group/event-log.jsonl
```

## Usage Awareness

Every agent response is tracked with token usage, cost, duration, and turn count. This data is visible to users in the web UI and persisted in the database.

**Be cost-conscious:** If a task requires many tool calls or large context, consider whether there's a more efficient approach. Users can see per-response costs and will flag expensive operations for optimization.

The host exposes usage data via API — agents with web access can query `http://host.docker.internal:3456/api/usage?hours=24` to review their own cost patterns.

## Scheduling

**ALWAYS use `mcp__nanoclaw__schedule_task` for recurring or delayed work.** Never use `CronCreate` — it's ephemeral and lost when the container stops.

ClawDad's scheduler persists tasks in the database, survives container restarts, and is visible in the web dashboard.

Examples:
- Morning report → `schedule_type: "cron"`, `schedule_value: "0 9 * * *"`
- One-shot in 30 min → `schedule_type: "once"`, `schedule_value: "<ISO timestamp>"`
- Hourly check → `schedule_type: "cron"`, `schedule_value: "0 * * * *"`

Use `mcp__nanoclaw__list_tasks` to check for existing tasks before creating duplicates.

## Task Scripts

For recurring tasks, if a simple check can determine whether action is needed, add a `script` — it runs first and the agent is only called when the check passes.

1. Provide a bash `script` alongside the `prompt` when scheduling
2. Script runs first (30-second timeout)
3. Script prints JSON: `{ "wakeAgent": true/false, "data": {...} }`
4. If `wakeAgent: false` — task waits for next run
5. If `wakeAgent: true` — agent wakes with script data + prompt

Test scripts in your sandbox before scheduling.
