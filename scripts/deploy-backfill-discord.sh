#!/usr/bin/env bash
# Backfill deployment events from Discord channel message history.
#
# Fetches all messages from #bd-deployments via Discord API, then extracts
# structured deployment events from the bot's narrative messages.
#
# What it recovers (that API-log backfill CANNOT):
#   - failure details: stage, test suite, specific test names, error messages
#   - gate_waiting / gate_resolved: approval waits with pipeline/version context
#   - e2e_results: pass/fail/skip counts per suite
#   - deploy_completed: outcomes with version and pipeline context
#   - deploy_triggered: execution IDs, run numbers, versions
#
# Usage:
#   deploy-backfill-discord.sh [--dry-run]
#   deploy-backfill-discord.sh --from-cache  # use previously fetched messages
#
# Requires: DISCORD_BOT_TOKEN in .env, curl, python3

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_ROOT/.env"
EVENT_LOG="$PROJECT_ROOT/groups/discord_deployments/event-log.jsonl"
CACHE_FILE="/tmp/discord-deployments-full.json"
CHANNEL_ID="1484050169480613959"

DRY_RUN=false
FROM_CACHE=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --from-cache) FROM_CACHE=true ;;
  esac
done

# --- Fetch messages from Discord API ---
if [[ "$FROM_CACHE" == "true" && -f "$CACHE_FILE" ]]; then
  echo "Using cached messages from $CACHE_FILE"
else
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "Error: .env not found at $ENV_FILE"
    exit 1
  fi
  TOKEN=$(grep DISCORD_BOT_TOKEN "$ENV_FILE" | cut -d= -f2-)
  if [[ -z "$TOKEN" ]]; then
    echo "Error: DISCORD_BOT_TOKEN not found in .env"
    exit 1
  fi

  echo "Fetching messages from Discord channel $CHANNEL_ID..."
  BEFORE=""
  TOTAL=0
  > "$CACHE_FILE.tmp"  # clear temp
  echo "[" > "$CACHE_FILE.tmp"
  FIRST=true

  while true; do
    URL="https://discord.com/api/v10/channels/$CHANNEL_ID/messages?limit=100"
    [[ -n "$BEFORE" ]] && URL="$URL&before=$BEFORE"

    BATCH=$(curl -s -H "Authorization: Bot $TOKEN" "$URL")
    COUNT=$(echo "$BATCH" | python3 -c "import sys,json; print(len(json.loads(sys.stdin.read())))" 2>/dev/null || echo "0")

    if [[ "$COUNT" -eq 0 ]]; then break; fi

    TOTAL=$((TOTAL + COUNT))
    if [[ "$FIRST" == "true" ]]; then
      FIRST=false
    else
      echo "," >> "$CACHE_FILE.tmp"
    fi
    echo "$BATCH" | python3 -c "
import sys, json
msgs = json.loads(sys.stdin.read())
print(','.join(json.dumps(m) for m in msgs))
" >> "$CACHE_FILE.tmp"

    BEFORE=$(echo "$BATCH" | python3 -c "import sys,json; msgs=json.loads(sys.stdin.read()); print(msgs[-1]['id'])")
    echo "  Fetched $COUNT (total: $TOTAL, oldest: $(echo "$BATCH" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())[-1]['timestamp'][:19])"))"

    [[ "$COUNT" -lt 100 ]] && break
    sleep 0.5
  done
  echo "]" >> "$CACHE_FILE.tmp"
  mv "$CACHE_FILE.tmp" "$CACHE_FILE"
  echo "Fetched $TOTAL messages total"
fi

echo ""
echo "=== Discord Deployment Event Backfill ==="
echo "Target: $EVENT_LOG"
echo ""

export _BF_CACHE="$CACHE_FILE"
export _BF_EVENT_LOG="$EVENT_LOG"
export _BF_DRY_RUN="$DRY_RUN"

python3 << 'PYEOF'
import json, re, os, sys
from collections import defaultdict
from datetime import datetime

cache_path = os.environ["_BF_CACHE"]
event_log_path = os.environ["_BF_EVENT_LOG"]
dry_run = os.environ["_BF_DRY_RUN"] == "true"

with open(cache_path) as f:
    all_msgs = json.load(f)

all_msgs.sort(key=lambda m: m["timestamp"])
bot_msgs = [m for m in all_msgs if m.get("author", {}).get("bot") and m["author"]["username"] == "NanoClaw"]

print(f"Total messages: {len(all_msgs)} ({len(bot_msgs)} from bot)")

events = []

def ts(msg):
    """Normalize Discord timestamp to ISO 8601 UTC."""
    t = msg["timestamp"]
    # Discord gives e.g. 2026-03-19T05:42:57.123000+00:00
    # Normalize to 2026-03-19T05:42:57Z
    m = re.match(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})', t)
    return m.group(1) + "Z" if m else t

def add_event(msg, event_type, **fields):
    e = {"ts": ts(msg), "event": event_type, **fields, "backfilled": True, "source": "discord"}
    events.append(e)

# -------------------------------------------------------------------
# 1. Deploy triggers — "Execution ID:", "run #NNN", "Deployment is running"
# -------------------------------------------------------------------
for m in bot_msgs:
    c = m["content"]

    # Pattern: "Execution ID: `xxx`, run #NNN"
    exec_match = re.search(r'Execution\s*(?:ID)?[:\s]*`([A-Za-z0-9_-]+)`', c)
    run_match = re.search(r'run\s*#(\d+)', c, re.I)
    if exec_match and ("running" in c.lower() or "triggered" in c.lower() or "polling" in c.lower() or run_match):
        pipeline = None
        for p in re.findall(r'`((?:dev|production)\w+)`', c, re.I):
            pipeline = p
        version = None
        for v in re.findall(r'v?(\d+\.\d+\.\d+(?:-\d+)?)', c):
            version = v

        service = "unknown"
        cl = c.lower()
        if "kong" in cl or "kdp" in cl or "dev portal" in cl:
            service = "kong-dev-portal"
        elif "polaris" in cl or "main app" in cl or "mainapp" in cl:
            service = "polaris-ui"

        add_event(m, "deploy_triggered",
            execution_id=exec_match.group(1),
            run_number=int(run_match.group(1)) if run_match else None,
            pipeline=pipeline,
            service=service,
            version=version)

# -------------------------------------------------------------------
# 2. Gate waiting — "Approval Required", "waiting for approval", "ApprovalWaiting"
# -------------------------------------------------------------------
for m in bot_msgs:
    c = m["content"]
    cl = c.lower()
    if not ("approval" in cl and ("waiting" in cl or "required" in cl or "approvalwaiting" in cl)):
        continue
    # Avoid duplicates close together (same gate mention within 2 min)
    version = None
    for v in re.findall(r'v?(\d+\.\d+\.\d+(?:-\d+)?)', c):
        version = v
    pipeline = None
    for p in re.findall(r'`((?:dev|production)\w+)`', c, re.I):
        pipeline = p
    service = "unknown"
    if "kong" in cl or "kdp" in cl or "dev portal" in cl:
        service = "kong-dev-portal"
    elif "polaris" in cl or "main app" in cl:
        service = "polaris-ui"

    add_event(m, "gate_waiting",
        gate_type="approval",
        gate_name="production-deployment",
        pipeline=pipeline,
        service=service,
        version=version)

# -------------------------------------------------------------------
# 3. Failures — "FAILED", "❌", with stage/test details
# -------------------------------------------------------------------
for m in bot_msgs:
    c = m["content"]
    cl = c.lower()

    # Must have a failure indicator
    if not ("fail" in cl or "❌" in c or "aborted" in cl):
        continue
    # Must look like a deployment failure, not just mentioning failure in passing
    if not any(k in cl for k in ["stage", "pipeline", "deploy", "e2e", "suite", "execution"]):
        continue

    # Extract details
    stage = None
    # Match "Stage: `deployToCdev`" or "Stage `deploy_to_cdev`" — must look like an identifier
    stage_match = re.search(r'[Ss]tage[:\s]*`([a-zA-Z0-9_-]+)`', c)
    if not stage_match:
        # Also match "stage `xxx` failed" or "deploy_to_cdev failed"
        stage_match = re.search(r'`(deploy\w+|Verify[\w-]+|altair[\w-]+)`', c)
    if stage_match:
        stage = stage_match.group(1)

    error_type = "unknown"
    if "abort" in cl:
        error_type = "aborted"
    elif "e2e" in cl or "test" in cl or "suite" in cl:
        error_type = "test_failure"
    elif "401" in c or "auth" in cl:
        error_type = "auth_failure"
    elif "timeout" in cl:
        error_type = "timeout"

    # Extract error message (first error/assertion line)
    error_msg = None
    err_match = re.search(r'(?:Error|AssertionError|Exception)[:\s]*(.{10,150})', c)
    if err_match:
        error_msg = err_match.group(0)[:200]

    # Failed test name
    test_match = re.search(r'[Ff]ailed\s*test[:\s]*`?(\w+)', c)
    if not test_match:
        test_match = re.search(r'❌\s*(\w+Test\w*)', c)

    pipeline = None
    for p in re.findall(r'`?((?:dev|production)\w+(?:MainApp|kong\w*|latest))`?', c, re.I):
        pipeline = p
    run_match = re.search(r'#(\d+)', c)
    version = None
    for v in re.findall(r'v?(\d+\.\d+\.\d+(?:-\d+)?)', c):
        version = v

    service = "unknown"
    if "kong" in cl or "kdp" in cl or "dev portal" in cl:
        service = "kong-dev-portal"
    elif "polaris" in cl or "main app" in cl or "mainapp" in cl:
        service = "polaris-ui"

    exec_match = re.search(r'Execution[:\s]*`?([A-Za-z0-9_-]{10,})', c)

    add_event(m, "failure",
        stage=stage,
        error_type=error_type,
        error_message=error_msg,
        failed_test=test_match.group(1) if test_match else None,
        pipeline=pipeline,
        run_number=int(run_match.group(1)) if run_match else None,
        service=service,
        version=version,
        execution_id=exec_match.group(1) if exec_match else None)

# -------------------------------------------------------------------
# 4. E2E results — pass/fail/skip counts per suite
# -------------------------------------------------------------------
for m in bot_msgs:
    c = m["content"]
    cl = c.lower()

    if not (("webb" in cl or "e2e" in cl) and re.search(r'\d+\s*(pass|fail)', cl)):
        continue

    # Extract suite results
    suites = []
    # Pattern: "Suite: testng-xxx — N passed, N failed"
    for sm in re.finditer(r'(?:Suite[:\s]*)?`?(testng-[\w-]+)`?\s*[—-]\s*(.*?)(?:\n|$)', c):
        suite_name = sm.group(1)
        detail = sm.group(2)
        passed = re.search(r'(\d+)\s*(?:/\d+\s*)?pass', detail, re.I)
        failed = re.search(r'(\d+)\s*fail', detail, re.I)
        suites.append({
            "suite": suite_name,
            "passed": int(passed.group(1)) if passed else 0,
            "failed": int(failed.group(1)) if failed else 0,
        })

    # Also look for "N passed, N failed" without suite prefix
    if not suites:
        passed = re.search(r'(\d+)\s*pass', cl)
        failed = re.search(r'(\d+)\s*fail', cl)
        if passed or failed:
            suites.append({
                "suite": "unknown",
                "passed": int(passed.group(1)) if passed else 0,
                "failed": int(failed.group(1)) if failed else 0,
            })

    if not suites:
        continue

    total_passed = sum(s["passed"] for s in suites)
    total_failed = sum(s["failed"] for s in suites)

    version = None
    for v in re.findall(r'v?(\d+\.\d+\.\d+(?:-\d+)?)', c):
        version = v
    service = "unknown"
    if "kong" in cl or "kdp" in cl or "dev portal" in cl:
        service = "kong-dev-portal"
    elif "polaris" in cl or "main app" in cl or "mainapp" in cl:
        service = "polaris-ui"

    run_match = re.search(r'[Rr]un\s*(?:#|ID[:\s]*)(\d+)', c)
    exec_match = re.search(r'Execution[:\s]*`?([A-Za-z0-9_-]{10,})', c)

    add_event(m, "e2e_results",
        service=service,
        version=version,
        webb_run_id=int(run_match.group(1)) if run_match else None,
        execution_id=exec_match.group(1) if exec_match else None,
        total_passed=total_passed,
        total_failed=total_failed,
        suites=suites)

# -------------------------------------------------------------------
# 5. Deploy completed — "✅ ... complete", "Success", final outcomes
# -------------------------------------------------------------------
for m in bot_msgs:
    c = m["content"]
    cl = c.lower()

    # Must be a clear deployment completion — not just "all pre-prod passed" (that's gate context)
    if not (("✅" in c and "complete" in cl) or
            ("pipeline is" in cl and "success" in cl and "complete" in cl)):
        continue
    # Reject gate-waiting messages that mention success of pre-prod stages
    if "approval" in cl or "waiting" in cl or "approvalwaiting" in cl:
        continue
    # Avoid E2E-only messages (those are captured above)
    if "e2e" in cl and "deploy" not in cl and "pipeline" not in cl and "complete" not in cl:
        continue

    pipeline = None
    for p in re.findall(r'`?((?:dev|production)\w+(?:MainApp|kong\w*|latest))`?', c, re.I):
        pipeline = p
    version = None
    for v in re.findall(r'v?(\d+\.\d+\.\d+(?:-\d+)?)', c):
        version = v
    run_match = re.search(r'[Rr]un\s*#(\d+)', c)
    exec_match = re.search(r'Execution[:\s]*`?([A-Za-z0-9_-]{10,})', c)

    service = "unknown"
    if "kong" in cl or "kdp" in cl or "dev portal" in cl:
        service = "kong-dev-portal"
    elif "polaris" in cl or "main app" in cl or "mainapp" in cl:
        service = "polaris-ui"

    add_event(m, "deploy_completed",
        outcome="success",
        pipeline=pipeline,
        service=service,
        version=version,
        run_number=int(run_match.group(1)) if run_match else None,
        execution_id=exec_match.group(1) if exec_match else None)

# -------------------------------------------------------------------
# Deduplicate: if same event type within 2 minutes with same key fields, keep first
# -------------------------------------------------------------------
def dedup_key(e):
    if e["event"] == "gate_waiting":
        return (e["event"], e.get("service"), e.get("version"))
    if e["event"] == "failure":
        return (e["event"], e.get("stage"), e.get("failed_test"), e.get("version"))
    if e["event"] == "deploy_triggered":
        return (e["event"], e.get("execution_id"))
    if e["event"] == "deploy_completed":
        return (e["event"], e.get("service"), e.get("version"))
    if e["event"] == "e2e_results":
        return (e["event"], e.get("service"), e.get("version"), e.get("total_passed"), e.get("total_failed"))
    return (e["event"], e["ts"])

# Different dedup windows by event type — the agent is chatty and
# often repeats the same status multiple times across a monitoring session
DEDUP_WINDOW = {
    "gate_waiting": 3600,       # 60 min — same gate mentioned many times
    "failure": 3600,            # 60 min — same failure restated
    "deploy_completed": 3600,   # 60 min — completion confirmed multiple times
    "e2e_results": 1800,        # 30 min — same results re-reported
    "deploy_triggered": 300,    # 5 min — should be unique per execution
}

deduped = []
seen = {}
for e in events:
    key = dedup_key(e)
    t = datetime.fromisoformat(e["ts"].replace("Z", "+00:00"))
    window = DEDUP_WINDOW.get(e["event"], 120)
    if key in seen:
        prev_t = seen[key]
        if abs((t - prev_t).total_seconds()) < window:
            continue
    seen[key] = t
    deduped.append(e)

events = deduped

# Strip None values for cleaner output
def clean(e):
    return {k: v for k, v in e.items() if v is not None}

events = [clean(e) for e in events]
events.sort(key=lambda e: e.get("ts", ""))

# --- Report ---
print(f"\nExtracted events (after dedup): {len(events)}")
from collections import Counter
type_counts = Counter(e["event"] for e in events)
for t, c in type_counts.most_common():
    print(f"  {t}: {c}")

# Service breakdown
print("\nBy service:")
svc_counts = Counter(e.get("service", "unknown") for e in events)
for s, c in svc_counts.most_common():
    print(f"  {s}: {c}")

# Version breakdown
print("\nVersions seen:")
versions = set()
for e in events:
    v = e.get("version")
    if v:
        versions.add(v)
for v in sorted(versions):
    print(f"  {v}")

if dry_run:
    print("\n--- DRY RUN (first 10 events) ---")
    for e in events[:10]:
        print(json.dumps(e, separators=(",", ":")))
    print(f"\n(Would write {len(events)} events to {event_log_path})")
else:
    # Read existing events to avoid duplicates with API-log backfill
    existing = set()
    if os.path.exists(event_log_path):
        with open(event_log_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                    # Key: ts + event type
                    existing.add((e.get("ts"), e.get("event")))
                except:
                    continue

    new_events = [e for e in events if (e["ts"], e["event"]) not in existing]
    print(f"\nSkipping {len(events) - len(new_events)} events already in log")
    print(f"Writing {len(new_events)} new events")

    with open(event_log_path, "a") as f:
        for e in new_events:
            f.write(json.dumps(e, separators=(",", ":")) + "\n")
    print(f"Appended to {event_log_path}")

    # Re-sort the entire log by timestamp
    all_events = []
    with open(event_log_path) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    all_events.append(json.loads(line))
                except:
                    continue
    all_events.sort(key=lambda e: e.get("ts", ""))
    with open(event_log_path, "w") as f:
        for e in all_events:
            f.write(json.dumps(e, separators=(",", ":")) + "\n")
    print(f"Re-sorted {len(all_events)} total events chronologically")

PYEOF
