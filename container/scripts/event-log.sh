#!/usr/bin/env bash
# Universal event logger — appends structured events to JSONL.
#
# Usage: event-log.sh <EVENT_TYPE> [key=value ...]
#
# Required: EVENT_TYPE (first positional arg)
# Optional: Any number of key=value pairs become JSON fields
#
# Auto-added fields: ts (ISO 8601 UTC timestamp)
#
# Output: One JSON line appended to $EVENT_LOG_FILE
#   (defaults to /workspace/group/event-log.jsonl)
#
# Values are auto-coerced: numbers → int/float, true/false → boolean,
# everything else → string. Use quotes for values with spaces.
#
# Examples:
#   event-log.sh deploy_triggered execution_id=abc123 pipeline=myapp version=v2.1.0
#   event-log.sh failure execution_id=abc123 stage=e2e error_type=test_failure error_message="3 tests failed"
#   event-log.sh scanned ticket=PROJ-1234 query_tier=2 summary="Null check missing"
#   event-log.sh gate_resolved execution_id=abc123 gate_type=approval outcome=approved wait_s=3600

set -euo pipefail

EVENT="${1:?Usage: event-log.sh EVENT_TYPE [key=value ...]}"
shift

LOG_FILE="${EVENT_LOG_FILE:-/workspace/group/event-log.jsonl}"
LOG_DIR=$(dirname "$LOG_FILE")
mkdir -p "$LOG_DIR"

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

python3 -c "
import sys, json

event = {'ts': sys.argv[1], 'event': sys.argv[2]}

for arg in sys.argv[3:]:
    eq = arg.find('=')
    if eq < 1:
        continue
    k = arg[:eq]
    v = arg[eq+1:]
    # Auto-coerce types
    if v.lower() == 'true':
        v = True
    elif v.lower() == 'false':
        v = False
    else:
        try:
            v = int(v)
        except ValueError:
            try:
                v = float(v)
            except ValueError:
                pass
    event[k] = v

print(json.dumps(event, separators=(',', ':')))
" "$TS" "$EVENT" "$@" >> "$LOG_FILE"
