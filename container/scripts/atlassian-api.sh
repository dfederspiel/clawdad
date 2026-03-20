#!/usr/bin/env bash
# Atlassian REST API wrapper — logs all requests and captures failures.
# Usage: atlassian-api.sh <METHOD> <PATH> [CURL_ARGS...]
#
# Examples:
#   atlassian-api.sh GET "/rest/api/3/issue/POLUIG-1234"
#   atlassian-api.sh POST "/rest/api/3/issue" -d '{"fields":{...}}'
#   atlassian-api.sh GET "/wiki/rest/api/content/12345?expand=body.storage"
#   atlassian-api.sh GET "/rest/api/3/search" --data-urlencode "jql=project=POLUIG"
#
# Environment: ATLASSIAN_BASE_URL, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN

set -euo pipefail

LOG_DIR="/workspace/group/api-logs"
LOG_FILE="$LOG_DIR/atlassian.jsonl"
mkdir -p "$LOG_DIR"

METHOD="${1:?Usage: atlassian-api.sh METHOD PATH [CURL_ARGS...]}"
API_PATH="${2:?Usage: atlassian-api.sh METHOD PATH [CURL_ARGS...]}"
shift 2

BASE_URL="${ATLASSIAN_BASE_URL:?ATLASSIAN_BASE_URL not set}"
URL="${BASE_URL}${API_PATH}"

TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

HTTP_CODE=$(curl -s -o "$TMPFILE" -w "%{http_code}" \
  -X "$METHOD" \
  -H "Content-Type: application/json" \
  -u "$ATLASSIAN_EMAIL:$ATLASSIAN_API_TOKEN" \
  "$URL" "$@" 2>&1) || HTTP_CODE="000"

BODY=$(cat "$TMPFILE")
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BODY_LEN=${#BODY}

# Determine success/failure
if [[ "$HTTP_CODE" =~ ^2 ]]; then
  STATUS="ok"
else
  STATUS="error"
fi

# Log entry (always log errors, optionally log successes)
if [[ "$STATUS" == "error" ]]; then
  # Truncate error body for log (keep first 500 chars)
  ERR_BODY="${BODY:0:500}"
  # Escape for JSON
  ERR_BODY=$(echo "$ERR_BODY" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))")
  printf '{"ts":"%s","method":"%s","path":"%s","status":%s,"ok":false,"error":%s}\n' \
    "$TIMESTAMP" "$METHOD" "$API_PATH" "$HTTP_CODE" "$ERR_BODY" >> "$LOG_FILE"
  echo "API ERROR ($HTTP_CODE): $METHOD $API_PATH" >&2
  echo "$BODY" >&2
fi

# Always log a summary line (success or failure)
printf '{"ts":"%s","method":"%s","path":"%s","status":%s,"ok":%s,"bytes":%d}\n' \
  "$TIMESTAMP" "$METHOD" "$API_PATH" "$HTTP_CODE" "$([[ $STATUS == ok ]] && echo true || echo false)" "$BODY_LEN" \
  >> "${LOG_DIR}/all-requests.jsonl"

# Output the response body to stdout (agent reads this)
echo "$BODY"
exit 0
