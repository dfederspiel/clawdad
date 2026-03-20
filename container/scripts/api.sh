#!/usr/bin/env bash
# Universal API wrapper — logs all requests and captures failures.
#
# Usage: api.sh <SERVICE> <METHOD> <URL> [CURL_ARGS...]
#
# SERVICE is a label for grouping logs (e.g., gitlab, harness, blackduck, launchdarkly, atlassian, webb)
# METHOD is the HTTP method (GET, POST, PUT, PATCH, DELETE)
# URL is the full URL (unlike atlassian-api.sh, this takes the complete URL)
#
# Exit codes:
#   0 — success (2xx response)
#   1 — HTTP error (non-2xx response, body still written to stdout)
#   2 — connection failure (DNS, timeout, network — no response at all)
#
# Examples:
#   api.sh gitlab GET "$GITLAB_URL/api/v4/projects/9634/pipelines?per_page=5" \
#     -H "PRIVATE-TOKEN: $GITLAB_TOKEN"
#
#   api.sh harness POST "https://app.harness.io/pipeline/api/pipeline/execute/..." \
#     -H "x-api-key: $HARNESS_API_KEY" -H "Content-Type: application/yaml" -d '...'
#
#   api.sh atlassian GET "https://blackduck.atlassian.net/rest/api/3/issue/POLUIG-1234" \
#     -u "$ATLASSIAN_EMAIL:$ATLASSIAN_API_TOKEN"
#
#   api.sh launchdarkly GET "https://app.launchdarkly.com/api/v2/flags/polaris-nextgen/my-flag" \
#     -H "Authorization: $LAUNCHDARKLY_API_KEY" -H "Ld-Api-Version: 20240415"

set -euo pipefail

LOG_DIR="/workspace/group/api-logs"
mkdir -p "$LOG_DIR"

SERVICE="${1:?Usage: api.sh SERVICE METHOD URL [CURL_ARGS...]}"
METHOD="${2:?Usage: api.sh SERVICE METHOD URL [CURL_ARGS...]}"
URL="${3:?Usage: api.sh SERVICE METHOD URL [CURL_ARGS...]}"
shift 3

# Extract host and path for logging
HOST=$(echo "$URL" | sed 's|^https\?://\([^/]*\).*|\1|')
API_PATH=$(echo "$URL" | sed 's|^https\?://[^/]*||')

TMPFILE=$(mktemp)
CURL_STDERR=$(mktemp)
trap 'rm -f "$TMPFILE" "$CURL_STDERR"' EXIT

# Time the request and capture stderr separately
START_MS=$(python3 -c "import time; print(int(time.time()*1000))")

HTTP_CODE=$(curl -s -o "$TMPFILE" -w "%{http_code}" \
  --connect-timeout 15 --max-time 120 \
  -X "$METHOD" "$URL" "$@" 2>"$CURL_STDERR") || {
  CURL_EXIT=$?
  HTTP_CODE="000"
}

END_MS=$(python3 -c "import time; print(int(time.time()*1000))")
DURATION_MS=$(( END_MS - START_MS ))

BODY=$(cat "$TMPFILE")
CURL_ERR=$(cat "$CURL_STDERR" 2>/dev/null | head -5 | tr '\n' ' ' | sed 's/[[:space:]]*$//')
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BODY_LEN=${#BODY}

if [[ "$HTTP_CODE" =~ ^2 ]]; then
  STATUS="ok"
else
  STATUS="error"
fi

# Build the error detail string
if [[ "$STATUS" == "error" ]]; then
  if [[ "$HTTP_CODE" == "000" ]]; then
    # Connection-level failure — curl error is the important info
    if [[ -n "$CURL_ERR" ]]; then
      ERR_DETAIL="$CURL_ERR"
    else
      ERR_DETAIL="Connection failed (no response from $HOST)"
    fi
    ERR_DETAIL_JSON=$(echo "$ERR_DETAIL" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))")
  else
    # HTTP error — response body has the details
    ERR_BODY="${BODY:0:500}"
    ERR_DETAIL_JSON=$(echo "$ERR_BODY" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))")
  fi

  # Log error with full context
  printf '{"ts":"%s","service":"%s","method":"%s","host":"%s","path":"%s","status":%s,"ok":false,"duration_ms":%d,"error":%s}\n' \
    "$TIMESTAMP" "$SERVICE" "$METHOD" "$HOST" "$API_PATH" "$HTTP_CODE" "$DURATION_MS" "$ERR_DETAIL_JSON" \
    >> "${LOG_DIR}/${SERVICE}-errors.jsonl"

  # Stderr message with enough detail to act on
  if [[ "$HTTP_CODE" == "000" ]]; then
    echo "API CONNECTION FAILED: $METHOD $HOST$API_PATH — $ERR_DETAIL (${DURATION_MS}ms)" >&2
  else
    echo "API ERROR ($HTTP_CODE): $METHOD $API_PATH (${DURATION_MS}ms)" >&2
  fi
fi

# Always log a summary line
printf '{"ts":"%s","service":"%s","method":"%s","host":"%s","path":"%s","status":%s,"ok":%s,"bytes":%d,"duration_ms":%d}\n' \
  "$TIMESTAMP" "$SERVICE" "$METHOD" "$HOST" "$API_PATH" "$HTTP_CODE" \
  "$([[ $STATUS == ok ]] && echo true || echo false)" "$BODY_LEN" "$DURATION_MS" \
  >> "${LOG_DIR}/all-requests.jsonl"

# Track consecutive failures per host for alerting
FAIL_COUNTER="${LOG_DIR}/.consecutive-failures-${SERVICE}"
if [[ "$STATUS" == "error" ]]; then
  PREV_COUNT=0
  [[ -f "$FAIL_COUNTER" ]] && PREV_COUNT=$(cat "$FAIL_COUNTER" 2>/dev/null || echo 0)
  NEW_COUNT=$((PREV_COUNT + 1))
  echo "$NEW_COUNT" > "$FAIL_COUNTER"

  if [[ "$NEW_COUNT" -ge 3 ]]; then
    echo "" >&2
    echo "WARNING: $NEW_COUNT consecutive failures for $SERVICE ($HOST)" >&2
    if [[ "$HTTP_CODE" == "000" ]]; then
      echo "  This looks like a network/DNS issue — check VPN, container DNS, or host reachability" >&2
    elif [[ "$HTTP_CODE" == "401" || "$HTTP_CODE" == "403" ]]; then
      echo "  This looks like an auth issue — token may be expired or missing permissions" >&2
    elif [[ "$HTTP_CODE" == "429" ]]; then
      echo "  Rate limited — add delays between requests or reduce polling frequency" >&2
    fi
    echo "  Last $NEW_COUNT errors in: ${LOG_DIR}/${SERVICE}-errors.jsonl" >&2
    echo "" >&2
  fi
else
  # Reset counter on success
  rm -f "$FAIL_COUNTER" 2>/dev/null
fi

# Output response body to stdout
echo "$BODY"

# Exit with meaningful code so callers can detect failures
if [[ "$STATUS" == "ok" ]]; then
  exit 0
elif [[ "$HTTP_CODE" == "000" ]]; then
  exit 2
else
  exit 1
fi
