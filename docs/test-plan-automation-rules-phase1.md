# Test Plan: Automation Rules Phase 1

**Goal:** Verify that rules load from `group-config.json`, evaluate correctly against live events, and produce trace logs — without affecting any existing behavior.

**Setup:** Run with `LOG_LEVEL=debug` so debug-level `[automation]` messages are visible.

```bash
LOG_LEVEL=debug npm run dev
```

---

## Test 1: Message pattern rule fires on @mention

**Group:** `web_test-team`

**Config:** Add to `groups/web_test-team/group-config.json`:
```json
{
  "automation": [
    {
      "id": "route-analyst",
      "enabled": true,
      "when": { "event": "message", "pattern": "@analyst" },
      "then": [{ "type": "delegate_to_agent", "agent": "analyst", "silent": false }]
    }
  ]
}
```

**Steps:**
1. Open web UI, go to test-team
2. Send: `@DavidAF @analyst check the latest numbers`
3. Watch the terminal logs

**Expected:** Log line:
```
[automation] rule matched (dry-run)
    ruleId: "route-analyst"
    sourceEvent: "message"
    actions: [{"type":"delegate_to_agent","targetAgent":"analyst","silent":false}]
    outcome: "would_fire"
```

**Also verify:** The message still routes normally through the existing trigger/coordinator path. Automation rules should not change behavior.

---

## Test 2: Rule does NOT fire when pattern is absent

**Config:** Same as Test 1 (pattern: `@analyst`)

**Steps:**
1. Send: `@DavidAF hey team, how's it going?`

**Expected:**
- Debug log: `[automation] no rules matched`
- No `rule matched` log entry

---

## Test 3: Sender filter — user-only rule ignores bot messages

**Config:** Add a second rule to `group-config.json`:
```json
{
  "id": "user-messages-only",
  "enabled": true,
  "when": { "event": "message", "sender": "user" },
  "then": [{ "type": "post_system_note", "text": "New user message", "visible": true }]
}
```

**Steps:**
1. Send a message as yourself — should fire
2. Watch the coordinator's response come back — the automation should also evaluate on bot messages but the `sender: "user"` rule should NOT match assistant messages

**Expected:**
- Your message: `rule matched` with `eventSummary: "message from user"`
- Bot response: no match for the user-only rule (may match other rules without sender filter)

---

## Test 4: Agent result rule fires after specialist responds

**Config:**
```json
{
  "id": "summarize-after-analyst",
  "enabled": true,
  "when": { "event": "agent_result", "agent": "analyst" },
  "then": [{ "type": "delegate_to_agent", "agent": "writer", "silent": true }]
}
```

**Steps:**
1. Send: `@DavidAF @analyst what's the market doing?`
2. Wait for the analyst agent to respond

**Expected:** After the analyst's output arrives:
```
[automation] rule matched (dry-run)
    ruleId: "summarize-after-analyst"
    sourceEvent: "agent_result"
    actions: [{"type":"delegate_to_agent","targetAgent":"writer","silent":true}]
    eventSummary: "agent_result from analyst"
```

---

## Test 5: Agent result `contains` filter

**Config:**
```json
{
  "id": "escalate-urgent",
  "enabled": true,
  "when": { "event": "agent_result", "contains": "URGENT" },
  "then": [{ "type": "delegate_to_agent", "agent": "coordinator", "silent": false }]
}
```

**Steps:**
1. Send a message that prompts the agent to include "URGENT" in its response (e.g. ask it to respond with that word)
2. Send a normal message that won't produce "URGENT" in the response

**Expected:**
- First case: rule fires
- Second case: rule does not fire

**Note:** This test is harder to control since you can't force agent output. If it's impractical, verify via unit tests instead (already covered in `automation-rules.test.ts`).

---

## Test 6: Task completion rule fires

**Config:** Add automation to the group that owns a scheduled task.

```json
{
  "id": "post-task-followup",
  "enabled": true,
  "when": { "event": "task_completed" },
  "then": [{ "type": "delegate_to_agent", "agent": "writer", "silent": true }]
}
```

**Steps:**
1. Create a simple scheduled task for the group (via web UI or API)
2. Wait for it to fire, or trigger it manually

**Expected:** After task completes:
```
[automation] rule matched (dry-run)
    ruleId: "post-task-followup"
    sourceEvent: "task_completed"
```

---

## Test 7: Disabled rule is ignored

**Config:**
```json
{
  "id": "disabled-rule",
  "enabled": false,
  "when": { "event": "message" },
  "then": [{ "type": "delegate_to_agent", "agent": "analyst" }]
}
```

**Steps:**
1. Send any message to the group

**Expected:** No trace log for `disabled-rule`. Only enabled rules appear in the loaded rules debug line.

---

## Test 8: Multiple rules fire on same event

**Config:**
```json
{
  "automation": [
    {
      "id": "rule-a",
      "enabled": true,
      "when": { "event": "message", "pattern": "@analyst" },
      "then": [{ "type": "delegate_to_agent", "agent": "analyst" }]
    },
    {
      "id": "rule-b",
      "enabled": true,
      "when": { "event": "message", "sender": "user" },
      "then": [{ "type": "post_system_note", "text": "user spoke" }]
    }
  ]
}
```

**Steps:**
1. Send: `@DavidAF @analyst check this`

**Expected:** Two separate `rule matched` log entries — one for `rule-a`, one for `rule-b`.

---

## Test 9: No automation key — no errors

**Group:** `web_general` (no group-config.json, or one without `automation`)

**Steps:**
1. Send a message to this group

**Expected:** No `[automation]` log lines at all. No errors, no warnings. Silent pass-through.

---

## Test 10: Malformed rule is skipped gracefully

**Config:**
```json
{
  "automation": [
    { "when": { "event": "message" }, "then": [] },
    {
      "id": "valid-rule",
      "enabled": true,
      "when": { "event": "message" },
      "then": [{ "type": "delegate_to_agent", "agent": "analyst" }]
    }
  ]
}
```

**Steps:**
1. Start the service, send a message

**Expected:**
- Warning: `[automation] skipping malformed rule` (for the rule missing `id`)
- The valid rule still loads and evaluates normally

---

## Regression Checklist

After running the above, verify these are unaffected:

- [ ] Single-agent groups still respond normally
- [ ] Multi-agent @mention routing still works
- [ ] Coordinator delegation still works
- [ ] Scheduled tasks still run and report results
- [ ] No new errors in logs during normal operation
- [ ] No measurable latency increase (rules are evaluated synchronously but config reads are fast)
