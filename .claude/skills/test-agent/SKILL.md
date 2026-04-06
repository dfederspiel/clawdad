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
groups = data.get('groups', data) if isinstance(data, dict) else data
for g in groups:
    print(f\"{g.get('jid','?')}  {g.get('name','?')}  folder={g.get('folder','?')}\")
"
```

Match the user's group name/folder to a JID. If ambiguous, ask.

### 2. Record the timestamp before sending

Capture an ISO timestamp right before sending. This is used with the `since` query param to fetch only messages from the test run — avoids the default 100-message limit.

```bash
SINCE=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
```

### 3. Send the message

```bash
curl -sf -X POST http://localhost:3456/api/send \
  -H 'Content-Type: application/json' \
  -d "{\"jid\": \"${JID}\", \"content\": \"${MESSAGE}\", \"sender\": \"${SENDER}\"}"
```

Verify `{"ok": true}` response.

### 4. Wait and poll for responses

Poll every 5 seconds for up to 90 seconds. Fetch messages since the pre-test timestamp. Stop polling once the message count stabilizes (same count for two consecutive checks and at least 1 response exists) or timeout is reached.

```bash
PREV=0
for i in $(seq 1 18); do
  sleep 5
  COUNT=$(curl -sf "http://localhost:3456/api/messages/${JID}?since=${SINCE}" | python3 -c "
import sys, json
msgs = json.load(sys.stdin).get('messages', [])
print(len(msgs))
")
  echo "Poll $i (${i}*5s): $COUNT msgs"
  if [ "$COUNT" = "$PREV" ] && [ "$COUNT" -gt 1 ]; then
    echo "Stabilized at $COUNT"
    break
  fi
  PREV=$COUNT
done
```

### 5. Report the message chain

Fetch all messages since the test timestamp and display with sender, content preview, and cost:

```bash
curl -sf "http://localhost:3456/api/messages/${JID}?since=${SINCE}" | python3 -c "
import sys, json
msgs = json.load(sys.stdin).get('messages', [])
total_cost = 0
for m in msgs:
    s = m.get('sender_name') or m.get('sender', '?')
    c = (m.get('content') or '')[:300]
    u = m.get('usage')
    cost_str = ''
    if u and isinstance(u, dict):
        cost = u.get('costUsd', 0)
        total_cost += cost
        cost_str = f'  [\${cost:.4f} | {u.get(\"numTurns\", \"?\")} turns | {u.get(\"durationMs\", \"?\")}ms | {u.get(\"containerReuse\", \"?\")}]'
    print(f'[{s}] {c}{cost_str}')
    print()
if total_cost > 0:
    print(f'--- Total cost: \${total_cost:.4f} ---')
"
```

### 6. Check logs for delegation routing and cost

```bash
tail -200 logs/nanoclaw.log | grep -iE "automation|rule fired|rule matched|delegation complete|retrigger|skip.*retrigger|completion_policy|usage stored" | tail -20
```

Also check for per-agent cost breakdown:

```bash
tail -200 logs/nanoclaw.log | grep -A6 "usage stored" | grep -E "agent|cost|turns|containerReuse" | tail -20
```

### 7. Summarize

Present a concise report:

```
Test: "@analyst explain recursion" → web:test-team

Message chain:
  1. [David] @analyst explain recursion in one sentence
  2. [Analyst] Recursion is...  [$0.38 | 1 turn | cold_start]
  3. [Writer] In short...  [$0.12 | 1 turn | cold_start]

Automation:
  - route-analyst fired → delegated to Analyst
  - summarize-after-analyst chained → delegated to Writer
  - Coordinator re-trigger: skipped (automation-only)

Cost: $0.50 total (2 agent runs)
Timing: 18s total (Analyst 12s, Writer 6s)
Status: ✓ Clean run — no errors, no duplicates
```

Flag any issues:
- Duplicate messages
- Missing agent responses
- Coordinator running when it shouldn't (or not running when it should)
- Unnecessary synthesis turns (coordinator re-triggered without adding value)
- Error logs
- Unexpectedly long response times (>30s per agent)
- High cost per turn (>$0.50 for a simple delegation)
