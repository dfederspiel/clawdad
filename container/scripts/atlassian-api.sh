#!/usr/bin/env bash
# Atlassian REST API wrapper — convenience shorthand that delegates to api.sh.
# Usage: atlassian-api.sh <METHOD> <PATH> [CURL_ARGS...]
#
# Examples:
#   atlassian-api.sh GET "/rest/api/3/issue/POLUIG-1234"
#   atlassian-api.sh POST "/rest/api/3/issue" -d '{"fields":{...}}'
#
# Environment: ATLASSIAN_BASE_URL, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN

set -euo pipefail

METHOD="${1:?Usage: atlassian-api.sh METHOD PATH [CURL_ARGS...]}"
API_PATH="${2:?Usage: atlassian-api.sh METHOD PATH [CURL_ARGS...]}"
shift 2

BASE_URL="${ATLASSIAN_BASE_URL:?ATLASSIAN_BASE_URL not set}"
URL="${BASE_URL}${API_PATH}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Auth: use env var if available, otherwise rely on credential proxy
AUTH_ARGS=()
if [[ -n "${ATLASSIAN_API_TOKEN:-}" ]]; then
  AUTH_ARGS+=(-u "$ATLASSIAN_EMAIL:$ATLASSIAN_API_TOKEN")
fi

exec "$SCRIPT_DIR/api.sh" atlassian "$METHOD" "$URL" \
  -H "Content-Type: application/json" \
  "${AUTH_ARGS[@]}" \
  "$@"
