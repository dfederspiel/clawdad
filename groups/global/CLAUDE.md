# ClawDad Agent — Global Defaults

These instructions apply to all agents running in ClawDad. Your individual CLAUDE.md adds persona, capabilities, and domain-specific behavior on top of these defaults.

## Communication

Your output is sent to the user in the web UI.

You also have `mcp__nanoclaw__send_message` which sends a message immediately while you're still working. Useful for acknowledging a request before starting longer work.

### Internal thoughts

Wrap internal reasoning in `<internal>` tags — it's logged but not sent:

```
<internal>Checking API rate limits before making the request.</internal>

Here's what I found...
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

## Credential Registration

If you need API credentials for a service, use the `mcp__nanoclaw__request_credential` tool. It opens a secure popup in the user's browser — you never see the secret.

**CRITICAL: Never ask users to paste secrets, API keys, or tokens in chat.** Always use `request_credential`.

```
Use mcp__nanoclaw__request_credential with:
- service: "github" (or "atlassian", "gitlab", "launchdarkly", or a custom name)
- host_pattern: "api.github.com" (optional — uses service default if omitted)
- description: "Why this credential is needed — shown to the user in the popup"
- email: "user@example.com" (required for Atlassian Basic auth)
```

The tool returns immediately — it does NOT block waiting for the user. The flow is:
1. Tool opens a popup in the user's browser with pre-filled metadata
2. Tool returns right away — continue with other work or tell the user what you're waiting for
3. User enters their secret in the form (you never see it)
4. Secret goes directly to the encrypted vault
5. A `[credential_registered]` message appears in the chat when done — that's your signal to proceed

### Using registered credentials

Once a credential is registered, it is injected **automatically** into all outbound HTTPS requests matching the service's host pattern. You don't need tokens, env vars, or auth headers — just make the API call:

```bash
# These work automatically after credential registration — no token needed:
curl -s https://api.github.com/user                    # GitHub
curl -s https://yourorg.atlassian.net/rest/api/3/myself # Atlassian
```

The credential proxy intercepts HTTPS traffic and injects the right `Authorization` header. Use `WebFetch`, `curl`, or Node `fetch()` — they all work. Do NOT try to read tokens from environment variables or pass auth headers manually.

To verify a credential works after registration:
```bash
curl -sf https://api.github.com/user          # GitHub — should return user JSON
```

**Security rules:**
- NEVER ask the user to paste tokens, keys, or passwords in chat
- NEVER store credentials in files, variables, or config
- NEVER echo, log, or print credential values
- If an API call fails with 401/403, call `request_credential` again — the token may have expired

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
