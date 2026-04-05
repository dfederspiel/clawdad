---
name: test-agent
description: Send a test message to an agent group and verify the response chain. Use when testing automation rules, multi-agent delegation, agent behavior, or after making changes to agent routing. Triggers on "test agent", "test automation", "test team", "send test message", or "/test-agent".
---

# Test Agent

Send a message to a group, wait for agents to respond, and report the full message chain and relevant logs. Replaces the manual curl → sleep → tail-logs cycle.

## Usage

The user provides:
- **Group** — which group to test (name or folder, e.g., "test-team")
- **Message** — what to send (e.g., "@analyst explain recursion in one sentence")
- **Sender** — optional, defaults to "David"

If not provided, ask using AskUserQuestion.

## Steps

### 1. Resolve the group JID

```bash
curl -sf http://localhost:3456/api/groups | python3 -c "
import sys, json
data = json.load(sys.stdin)
groups = [g for g in data if isinstance(g, dict)]
for g in groups:
    print(f\"{g.get('jid','?')}  {g.get('name','?')}  folder={g.get('folder','?')}\")
"
```

Match the user's group name/folder to a JID. If ambiguous, ask.

### 2. Capture pre-test message count

```bash
curl -sf "http://localhost:3456/api/messages/${JID}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if isinstance(data, dict):
    for v in data.values():
        if isinstance(v, list):
            data = v
            break
print(len(data))
"
```

### 3. Send the message

```bash
curl -sf -X POST http://localhost:3456/api/send \
  -H 'Content-Type: application/json' \
  -d "{\"jid\": \"${JID}\", \"content\": \"${MESSAGE}\", \"sender\": \"${SENDER}\"}"
```

Verify `{"ok": true}` response.

### 4. Wait and poll for responses

Poll every 5 seconds for up to 60 seconds. Check if new messages have appeared beyond the pre-test count. Stop polling once the message count stabilizes (same count for two consecutive checks) or timeout is reached.

```bash
# Poll loop — check for new messages
for i in $(seq 1 12); do
  sleep 5
  NEW_COUNT=$(curl -sf "http://localhost:3456/api/messages/${JID}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if isinstance(data, dict):
    for v in data.values():
        if isinstance(v, list):
            data = v
            break
print(len(data))
")
  echo "Poll $i: $NEW_COUNT messages"
  # Break if count stabilized
done
```

### 5. Report the message chain

Fetch all messages since the test message and display them:

```bash
curl -sf "http://localhost:3456/api/messages/${JID}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if isinstance(data, dict):
    for v in data.values():
        if isinstance(v, list):
            data = v
            break
# Show only messages after pre-test count
for m in data[${PRE_COUNT}:]:
    if isinstance(m, dict):
        s = m.get('sender_name') or m.get('sender', '?')
        c = (m.get('content') or '')[:300]
        print(f'[{s}] {c}')
        print()
"
```

### 6. Check automation logs

```bash
tail -200 logs/nanoclaw.log | grep -iE "automation|rule fired|rule matched|delegation complete|retrigger|skip.*retrigger" | tail -20
```

### 7. Summarize

Present a concise report:

```
Test: "@analyst explain recursion" → web:test-team

Message chain:
  1. [David] @analyst explain recursion in one sentence
  2. [Analyst] Recursion is...
  3. [Writer] In short...

Automation:
  - route-analyst fired → delegated to Analyst
  - summarize-after-analyst chained → delegated to Writer
  - Coordinator re-trigger: skipped (automation-only)

Timing: 18s total (Analyst 12s, Writer 6s)
Status: ✓ Clean run — no errors, no duplicates
```

Flag any issues:
- Duplicate messages
- Missing agent responses
- Coordinator running when it shouldn't (or not running when it should)
- Error logs
- Unexpectedly long response times (>30s per agent)
