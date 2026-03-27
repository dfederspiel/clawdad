#!/usr/bin/env bash
# Query the bug triage event log for reporting.
#
# Usage:
#   triage-report.sh                     # summary dashboard
#   triage-report.sh ticket POLUIG-1234  # lifecycle for one ticket
#   triage-report.sh events triaged      # all events of a type
#   triage-report.sh errors              # all error events
#   triage-report.sh prs                 # PR tracking
#   triage-report.sh daily               # today's activity
#   triage-report.sh weekly              # last 7 days

set -euo pipefail

LOG="${TRIAGE_LOG:-$(dirname "$0")/../groups/bug_triage/triage-log.jsonl}"

if [[ ! -f "$LOG" ]]; then
  echo "No triage log found at: $LOG"
  exit 1
fi

cmd="${1:-summary}"
arg="${2:-}"

case "$cmd" in

  summary)
    total_events=$(wc -l < "$LOG" | tr -d ' ')
    unique_tickets=$(jq -r '.ticket' "$LOG" | sort -u | wc -l | tr -d ' ')
    echo "=== Bug Triage Report ==="
    echo "Log: $LOG"
    echo "Total events: $total_events"
    echo "Unique tickets: $unique_tickets"
    echo ""

    echo "--- Events by type ---"
    jq -r '.event // .action_tier // "legacy"' "$LOG" | sort | uniq -c | sort -rn
    echo ""

    echo "--- Tickets by action tier ---"
    jq -r 'select(.event == "triaged" or .action_tier != null) | .action_tier // "unknown"' "$LOG" | sort | uniq -c | sort -rn
    echo ""

    echo "--- Confidence distribution ---"
    jq -r 'select(.confidence != null) | .confidence' "$LOG" | sort | uniq -c | sort -rn
    echo ""

    echo "--- PRs opened ---"
    jq -r 'select(.event == "pr_opened" or .pr_url != null) | "\(.ticket) \(.pr_url)"' "$LOG" 2>/dev/null || echo "  (none)"
    echo ""

    echo "--- Errors ---"
    error_count=$(jq -r 'select(.event == "error")' "$LOG" 2>/dev/null | wc -l | tr -d ' ')
    echo "  Total error events: $error_count"
    if [[ "$error_count" -gt 0 ]]; then
      jq -r 'select(.event == "error") | "  \(.timestamp) \(.ticket) \(.error_type): \(.error_message)"' "$LOG"
    fi
    echo ""

    echo "--- Recent activity (last 5 events) ---"
    tail -5 "$LOG" | jq -r '"\(.timestamp) [\(.event // .action_tier // "legacy")] \(.ticket)"'
    ;;

  ticket)
    if [[ -z "$arg" ]]; then
      echo "Usage: triage-report.sh ticket POLUIG-1234"
      exit 1
    fi
    echo "=== Lifecycle: $arg ==="
    jq -r "select(.ticket == \"$arg\") | \"\(.timestamp) [\(.event // .action_tier // \"legacy\")] \(del(.ticket, .timestamp, .event) | to_entries | map(\"\(.key)=\(.value)\") | join(\", \"))\"" "$LOG"
    ;;

  events)
    if [[ -z "$arg" ]]; then
      echo "Usage: triage-report.sh events <event_type>"
      echo "Types: scanned, triaged, commented, labeled, pr_opened, pr_merged, escalated, error"
      exit 1
    fi
    echo "=== Events: $arg ==="
    jq -r "select(.event == \"$arg\") | \"\(.timestamp) \(.ticket) \(del(.ticket, .timestamp, .event) | to_entries | map(\"\(.key)=\(.value)\") | join(\", \"))\"" "$LOG"
    ;;

  errors)
    echo "=== Error Events ==="
    jq -r 'select(.event == "error") | "\(.timestamp) \(.ticket) [\(.error_type)] \(.error_message)"' "$LOG"
    legacy_errors=$(jq -r 'select(.errors != null and (.errors | length) > 0) | "\(.timestamp) \(.ticket) \(.errors | join(", "))"' "$LOG" 2>/dev/null)
    if [[ -n "$legacy_errors" ]]; then
      echo ""
      echo "--- Legacy error fields ---"
      echo "$legacy_errors"
    fi
    ;;

  prs)
    echo "=== PR Tracking ==="
    echo ""
    echo "--- Opened ---"
    jq -r 'select(.event == "pr_opened" or .pr_url != null) | "\(.timestamp) \(.ticket) \(.pr_url // "no url") [\(.pr_repo // "unknown")]"' "$LOG"
    echo ""
    echo "--- Merged ---"
    jq -r 'select(.event == "pr_merged") | "\(.timestamp) \(.ticket) \(.pr_url)"' "$LOG" 2>/dev/null || echo "  (none tracked yet)"
    ;;

  daily)
    today=$(date -u +%Y-%m-%d)
    echo "=== Activity: $today ==="
    jq -r "select(.timestamp | startswith(\"$today\")) | \"\(.timestamp) [\(.event // .action_tier // \"legacy\")] \(.ticket)\"" "$LOG"
    ;;

  weekly)
    # Last 7 days
    if date -v-7d &>/dev/null; then
      week_ago=$(date -u -v-7d +%Y-%m-%d)
    else
      week_ago=$(date -u -d '7 days ago' +%Y-%m-%d)
    fi
    echo "=== Activity since $week_ago ==="
    jq -r "select(.timestamp >= \"$week_ago\") | \"\(.timestamp) [\(.event // .action_tier // \"legacy\")] \(.ticket)\"" "$LOG"
    echo ""
    echo "--- Summary ---"
    jq -r "select(.timestamp >= \"$week_ago\") | .event // .action_tier // \"legacy\"" "$LOG" | sort | uniq -c | sort -rn
    ;;

  *)
    echo "Usage: triage-report.sh [summary|ticket|events|errors|prs|daily|weekly]"
    echo ""
    echo "Commands:"
    echo "  summary              Overview dashboard (default)"
    echo "  ticket POLUIG-1234   Full lifecycle for one ticket"
    echo "  events <type>        All events of a type (scanned, triaged, commented, etc.)"
    echo "  errors               All error events"
    echo "  prs                  PR open/merge tracking"
    echo "  daily                Today's activity"
    echo "  weekly               Last 7 days"
    exit 1
    ;;
esac
