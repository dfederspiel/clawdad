#!/usr/bin/env bash
# Backfill deployment events from API request logs.
#
# Reads groups/discord_deployments/api-logs/all-requests.jsonl and synthesizes
# deployment events into groups/discord_deployments/event-log.jsonl.
#
# What it can recover:
#   - deploy_triggered: from Harness execute POST calls (pipeline name, timestamp)
#   - deploy_monitored: from Harness execution polling (execution ID, first/last poll, poll count)
#   - pipeline_detected: from GitLab pipeline GET calls
#   - e2e_monitoring: from Webb API polling clusters
#   - failure (backfilled): from service-specific error logs
#
# What it CANNOT recover (response bodies weren't logged):
#   - Stage-level durations, gate wait times, test counts, version numbers
#   - These will be captured going forward by the live event logger
#
# Usage: deploy-backfill.sh [--dry-run]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
API_LOG="$PROJECT_ROOT/groups/discord_deployments/api-logs/all-requests.jsonl"
ERROR_LOGS="$PROJECT_ROOT/groups/discord_deployments/api-logs"
EVENT_LOG="$PROJECT_ROOT/groups/discord_deployments/event-log.jsonl"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

if [[ ! -f "$API_LOG" ]]; then
  echo "API log not found: $API_LOG"
  exit 1
fi

echo "=== Deployment Event Backfill ==="
echo "Source: $API_LOG ($(wc -l < "$API_LOG" | tr -d ' ') entries)"
echo "Target: $EVENT_LOG"
echo ""

export _BF_API_LOG="$API_LOG"
export _BF_ERROR_LOGS="$ERROR_LOGS"
export _BF_EVENT_LOG="$EVENT_LOG"
export _BF_DRY_RUN="$DRY_RUN"

python3 << 'PYEOF'
import json, sys, re, os
from collections import defaultdict
from datetime import datetime

api_log_path = os.environ["_BF_API_LOG"]
error_logs_dir = os.environ["_BF_ERROR_LOGS"]
event_log_path = os.environ["_BF_EVENT_LOG"]
dry_run = os.environ["_BF_DRY_RUN"] == "true"

events = []

# --- Parse API log ---
entries = []
with open(api_log_path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            # Fix bare 000 status (connection failures logged as status:000)
            line = re.sub(r'"status":0{2,}', '"status":0', line)
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue

print(f"Parsed {len(entries)} API log entries")

# --- 1. Extract Harness pipeline triggers ---
# POST to /pipeline/api/pipeline/execute/{pipelineName}?...
triggers = []
for e in entries:
    if e.get("service") != "harness" or e.get("method") != "POST":
        continue
    path = e.get("path", "")
    m = re.match(r'/pipeline/api/pipeline/execute/([^?/]+)', path)
    if m and m.group(1) != "v2":  # exclude execution/v2 queries
        pipeline_name = m.group(1)
        triggers.append({
            "ts": e["ts"],
            "event": "deploy_triggered",
            "pipeline": pipeline_name,
            "service": "polaris-ui" if "MainApp" in pipeline_name and "kong" not in pipeline_name.lower() else "kong-dev-portal" if "kong" in pipeline_name.lower() else "unknown",
            "backfilled": True,
            "source": "api-log"
        })

print(f"Found {len(triggers)} pipeline triggers")
for t in triggers:
    events.append(t)

# --- 2. Group Harness execution polling by execution ID ---
exec_polls = defaultdict(list)
for e in entries:
    if e.get("service") != "harness":
        continue
    path = e.get("path", "")
    m = re.match(r'/pipeline/api/pipelines/execution/v2/([^?/]+)', path)
    if m:
        exec_id = m.group(1)
        # Skip non-execution endpoints
        if exec_id in ("summary",):
            continue
        exec_polls[exec_id].append(e)

print(f"Found {len(exec_polls)} unique execution IDs being monitored")

for exec_id, polls in exec_polls.items():
    if exec_id.endswith("/inputset"):
        continue
    timestamps = sorted([p["ts"] for p in polls])
    first = timestamps[0]
    last = timestamps[-1]

    # Compute duration
    try:
        t1 = datetime.fromisoformat(first.replace("Z", "+00:00"))
        t2 = datetime.fromisoformat(last.replace("Z", "+00:00"))
        duration_s = int((t2 - t1).total_seconds())
    except:
        duration_s = 0

    # Try to match to a trigger by finding the closest trigger before first poll
    matched_pipeline = None
    for t in sorted(triggers, key=lambda x: x["ts"], reverse=True):
        if t["ts"] <= first:
            # Within 5 minutes of trigger = likely match
            try:
                t_trigger = datetime.fromisoformat(t["ts"].replace("Z", "+00:00"))
                t_first = datetime.fromisoformat(first.replace("Z", "+00:00"))
                if (t_first - t_trigger).total_seconds() < 300:
                    matched_pipeline = t["pipeline"]
            except:
                pass
            break

    events.append({
        "ts": first,
        "event": "deploy_monitored",
        "execution_id": exec_id,
        "pipeline": matched_pipeline,
        "first_poll": first,
        "last_poll": last,
        "poll_count": len(polls),
        "monitoring_duration_s": duration_s,
        "backfilled": True,
        "source": "api-log"
    })

# --- 3. Extract GitLab pipeline monitoring ---
gitlab_pipelines = defaultdict(list)
for e in entries:
    if e.get("service") != "gitlab":
        continue
    path = e.get("path", "")
    m = re.match(r'/api/v4/projects/(\d+)/pipelines/(\d+)', path)
    if m:
        project_id = m.group(1)
        pipeline_id = m.group(2)
        gitlab_pipelines[pipeline_id].append(e)

print(f"Found {len(gitlab_pipelines)} GitLab pipelines monitored")

for pipeline_id, polls in gitlab_pipelines.items():
    timestamps = sorted([p["ts"] for p in polls])
    project_id = None
    for p in polls:
        m = re.match(r'/api/v4/projects/(\d+)/', p.get("path", ""))
        if m:
            project_id = m.group(1)
            break

    events.append({
        "ts": timestamps[0],
        "event": "pipeline_detected",
        "pipeline_id": pipeline_id,
        "project_id": project_id,
        "project": "polaris-ui" if project_id == "9634" else "kong-dev-portal" if project_id == "7087" else f"project-{project_id}",
        "poll_count": len(polls),
        "first_seen": timestamps[0],
        "last_seen": timestamps[-1],
        "backfilled": True,
        "source": "api-log"
    })

# --- 4. Extract Webb E2E monitoring clusters ---
webb_polls = []
for e in entries:
    if e.get("service") != "webb":
        continue
    webb_polls.append(e)

if webb_polls:
    # Group into clusters (gap > 30 min = new cluster)
    clusters = []
    current = [webb_polls[0]]
    for p in webb_polls[1:]:
        try:
            t_prev = datetime.fromisoformat(current[-1]["ts"].replace("Z", "+00:00"))
            t_curr = datetime.fromisoformat(p["ts"].replace("Z", "+00:00"))
            if (t_curr - t_prev).total_seconds() > 1800:
                clusters.append(current)
                current = [p]
            else:
                current.append(p)
        except:
            current.append(p)
    clusters.append(current)

    print(f"Found {len(clusters)} Webb E2E monitoring sessions ({len(webb_polls)} total polls)")

    for cluster in clusters:
        timestamps = sorted([p["ts"] for p in cluster])
        # Count runs vs tests calls
        runs_calls = sum(1 for p in cluster if "/api/runs" in p.get("path", ""))
        tests_calls = sum(1 for p in cluster if "/api/tests" in p.get("path", ""))

        events.append({
            "ts": timestamps[0],
            "event": "e2e_monitoring",
            "first_poll": timestamps[0],
            "last_poll": timestamps[-1],
            "poll_count": len(cluster),
            "runs_queries": runs_calls,
            "test_detail_queries": tests_calls,
            "backfilled": True,
            "source": "api-log"
        })

# --- 5. Extract errors as failure events ---
import glob

error_files = glob.glob(os.path.join(error_logs_dir, "*-errors.jsonl"))
error_count = 0
for ef in error_files:
    with open(ef) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                err = json.loads(line)
                events.append({
                    "ts": err.get("ts", ""),
                    "event": "api_error",
                    "service": err.get("service", "unknown"),
                    "error_type": f"http_{err.get('status', 'unknown')}",
                    "error_message": (err.get("error", ""))[:200],
                    "path": err.get("path", ""),
                    "backfilled": True,
                    "source": "error-log"
                })
                error_count += 1
            except json.JSONDecodeError:
                continue

print(f"Found {error_count} API errors across {len(error_files)} error logs")

# --- Sort and output ---
events.sort(key=lambda e: e.get("ts", ""))

print(f"\nTotal backfilled events: {len(events)}")
print(f"  deploy_triggered: {sum(1 for e in events if e['event'] == 'deploy_triggered')}")
print(f"  deploy_monitored: {sum(1 for e in events if e['event'] == 'deploy_monitored')}")
print(f"  pipeline_detected: {sum(1 for e in events if e['event'] == 'pipeline_detected')}")
print(f"  e2e_monitoring: {sum(1 for e in events if e['event'] == 'e2e_monitoring')}")
print(f"  api_error: {sum(1 for e in events if e['event'] == 'api_error')}")

if dry_run:
    print("\n--- DRY RUN (first 5 events) ---")
    for e in events[:5]:
        print(json.dumps(e, separators=(",", ":")))
    print(f"\n(Would write {len(events)} events to {event_log_path})")
else:
    with open(event_log_path, "a") as f:
        for e in events:
            f.write(json.dumps(e, separators=(",", ":")) + "\n")
    print(f"\nWrote {len(events)} events to {event_log_path}")

PYEOF
