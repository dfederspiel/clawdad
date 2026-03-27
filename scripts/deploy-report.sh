#!/usr/bin/env bash
# Query the deployment event log for reporting.
#
# Usage:
#   deploy-report.sh                          # summary dashboard
#   deploy-report.sh deployment <dep_id>      # lifecycle for one deployment
#   deploy-report.sh events <event_type>      # all events of a type
#   deploy-report.sh failures                 # all failure events
#   deploy-report.sh gates                    # gate wait time analysis
#   deploy-report.sh service <name>           # deployments for a service
#   deploy-report.sh daily                    # today's activity
#   deploy-report.sh weekly                   # last 7 days

set -euo pipefail

LOG="${DEPLOY_LOG:-$(dirname "$0")/../groups/discord_deployments/event-log.jsonl}"

if [[ ! -f "$LOG" ]]; then
  echo "No deployment event log found at: $LOG"
  exit 1
fi

cmd="${1:-summary}"
arg="${2:-}"

case "$cmd" in

  summary)
    total_events=$(wc -l < "$LOG" | tr -d ' ')
    deployments=$(jq -r 'select(.event == "deploy_triggered") | .deployment_id // .execution_id // "unknown"' "$LOG" | sort -u | wc -l | tr -d ' ')
    echo "=== Deployment Report ==="
    echo "Log: $LOG"
    echo "Total events: $total_events"
    echo "Unique deployments: $deployments"
    echo ""

    echo "--- Events by type ---"
    jq -r '.event' "$LOG" | sort | uniq -c | sort -rn
    echo ""

    echo "--- Deployments ---"
    jq -r 'select(.event == "deploy_triggered") | "\(.ts) \(.deployment_id // .execution_id) → \(.pipeline // "unknown") (\(.service // "unknown") \(.version // "?"))"' "$LOG"
    echo ""

    echo "--- Outcomes ---"
    jq -r 'select(.event == "deploy_completed") | "\(.deployment_id // .execution_id): \(.outcome // "unknown")"' "$LOG" | sort | uniq -c | sort -rn
    if [[ $(jq -c 'select(.event == "deploy_completed")' "$LOG" | wc -l) -eq 0 ]]; then
      echo "  (no deploy_completed events yet)"
    fi
    echo ""

    echo "--- Failures ---"
    fail_count=$(jq -c 'select(.event == "failure")' "$LOG" | wc -l | tr -d ' ')
    echo "  Total: $fail_count"
    if [[ "$fail_count" -gt 0 ]]; then
      jq -r 'select(.event == "failure") | "  \(.stage // "unknown"): \(.error_type // "unknown") — \(.error_message // "")"' "$LOG" | head -10
    fi
    echo ""

    echo "--- Gates ---"
    gate_count=$(jq -c 'select(.event == "gate_waiting")' "$LOG" | wc -l | tr -d ' ')
    resolved_count=$(jq -c 'select(.event == "gate_resolved")' "$LOG" | wc -l | tr -d ' ')
    echo "  Encountered: $gate_count"
    echo "  Resolved: $resolved_count"
    if [[ "$resolved_count" -gt 0 ]]; then
      echo "  Wait times:"
      jq -r 'select(.event == "gate_resolved" and .wait_s != null) | "    \(.gate_name // .gate_type // "unknown"): \(.wait_s)s (\((.wait_s / 60) | floor)m)"' "$LOG"
    fi
    echo ""

    echo "--- Recent activity (last 5 events) ---"
    tail -5 "$LOG" | jq -r '"\(.ts) [\(.event)] \(.deployment_id // .execution_id // .pipeline_id // "")"'
    ;;

  deployment)
    if [[ -z "$arg" ]]; then
      echo "Usage: deploy-report.sh deployment <deployment_id>"
      echo ""
      echo "Available deployments:"
      jq -r 'select(.deployment_id != null) | .deployment_id' "$LOG" | sort -u
      exit 1
    fi
    echo "=== Deployment: $arg ==="
    jq -r "select(.deployment_id == \"$arg\") | \"\(.ts) [\(.event)] \(del(.deployment_id, .ts, .event) | to_entries | map(\"\(.key)=\(.value)\") | join(\", \"))\"" "$LOG"
    ;;

  events)
    if [[ -z "$arg" ]]; then
      echo "Usage: deploy-report.sh events <event_type>"
      echo "Types: pipeline_detected, pipeline_completed, deploy_triggered, stage_completed,"
      echo "       gate_waiting, gate_resolved, e2e_results, security_check, failure, remediation, deploy_completed"
      exit 1
    fi
    echo "=== Events: $arg ==="
    jq -r "select(.event == \"$arg\") | \"\(.ts) \(.deployment_id // .execution_id // \"\") \(del(.ts, .event, .deployment_id) | to_entries | map(\"\(.key)=\(.value)\") | join(\", \"))\"" "$LOG"
    ;;

  failures)
    echo "=== Deployment Failures ==="
    fail_count=$(jq -c 'select(.event == "failure")' "$LOG" | wc -l | tr -d ' ')
    echo "Total: $fail_count"
    echo ""
    if [[ "$fail_count" -gt 0 ]]; then
      echo "--- By stage ---"
      jq -r 'select(.event == "failure") | .stage // "unknown"' "$LOG" | sort | uniq -c | sort -rn
      echo ""
      echo "--- By error type ---"
      jq -r 'select(.event == "failure") | .error_type // "unknown"' "$LOG" | sort | uniq -c | sort -rn
      echo ""
      echo "--- Details ---"
      jq -r 'select(.event == "failure") | "\(.ts) \(.deployment_id // .execution_id // "")\n  Stage: \(.stage // "unknown") | Type: \(.error_type // "unknown")\n  \(.error_message // "no message")\n  Remediation: \(.remediation // "none")\n"' "$LOG"
    fi
    ;;

  gates)
    echo "=== Gate Analysis ==="
    echo ""
    echo "--- Waiting ---"
    jq -r 'select(.event == "gate_waiting") | "\(.ts) \(.deployment_id // .execution_id // "") \(.gate_type // "unknown"): \(.gate_name // "")"' "$LOG"
    echo ""
    echo "--- Resolved ---"
    jq -r 'select(.event == "gate_resolved") | "\(.ts) \(.deployment_id // .execution_id // "") \(.gate_name // .gate_type // "unknown"): \(.outcome // "?") (waited \(.wait_s // "?")s / \(((.wait_s // 0) / 60) | floor)m)"' "$LOG"
    echo ""
    resolved_count=$(jq -c 'select(.event == "gate_resolved" and .wait_s != null)' "$LOG" | wc -l | tr -d ' ')
    if [[ "$resolved_count" -gt 0 ]]; then
      echo "--- Stats ---"
      jq -s '[.[] | select(.event == "gate_resolved" and .wait_s != null) | .wait_s] | {
        count: length,
        avg_s: ((add / length) | floor),
        min_s: min,
        max_s: max,
        avg_min: ((add / length / 60) | floor),
        max_min: ((max / 60) | floor)
      }' "$LOG"
    fi
    ;;

  service)
    if [[ -z "$arg" ]]; then
      echo "Usage: deploy-report.sh service <service_name>"
      echo ""
      echo "Services seen:"
      jq -r 'select(.service != null) | .service' "$LOG" | sort -u
      exit 1
    fi
    echo "=== Service: $arg ==="
    jq -r "select(.service == \"$arg\") | \"\(.ts) [\(.event)] \(.deployment_id // .execution_id // \"\") \(del(.ts, .event, .deployment_id, .service) | to_entries | map(\"\(.key)=\(.value)\") | join(\", \"))\"" "$LOG"
    ;;

  daily)
    today=$(date -u +%Y-%m-%d)
    echo "=== Deployment Activity: $today ==="
    jq -r "select(.ts | startswith(\"$today\")) | \"\(.ts) [\(.event)] \(.deployment_id // .execution_id // .pipeline_id // \"\")\"" "$LOG"
    count=$(jq -r "select(.ts | startswith(\"$today\"))" "$LOG" | wc -l | tr -d ' ')
    echo ""
    echo "Total events today: $count"
    ;;

  weekly)
    if date -v-7d &>/dev/null; then
      week_ago=$(date -u -v-7d +%Y-%m-%d)
    else
      week_ago=$(date -u -d '7 days ago' +%Y-%m-%d)
    fi
    echo "=== Deployment Activity since $week_ago ==="
    jq -r "select(.ts >= \"$week_ago\") | \"\(.ts) [\(.event)] \(.deployment_id // .execution_id // .pipeline_id // \"\")\"" "$LOG"
    echo ""
    echo "--- Summary ---"
    jq -r "select(.ts >= \"$week_ago\") | .event" "$LOG" | sort | uniq -c | sort -rn
    ;;

  *)
    echo "Usage: deploy-report.sh [summary|deployment|events|failures|gates|service|daily|weekly]"
    echo ""
    echo "Commands:"
    echo "  summary              Overview dashboard (default)"
    echo "  deployment <id>      Full event timeline for one deployment"
    echo "  events <type>        All events of a type"
    echo "  failures             Failure analysis (by stage, error type, details)"
    echo "  gates                Gate wait time analysis"
    echo "  service <name>       Filter by service (polaris-ui, kong)"
    echo "  daily                Today's activity"
    echo "  weekly               Last 7 days"
    exit 1
    ;;
esac
