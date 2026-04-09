#!/usr/bin/env bash
# Polaris Authentication Helper — Multi-Environment
#
# Source this file with an environment name to get session cookies.
# Sessions are maintained by the host-level keepalive system (Playwright
# browser auth + periodic ping) and shared via
# /workspace/global/sessions/{env}.json (read-only mount).
#
# Provides:
#   $POLARIS_COOKIES      — cookie string for: curl -b "$POLARIS_COOKIES" ...
#   $POLARIS_BASE_URL     — base URL for the environment
#   $POLARIS_ENV          — environment name
#   $POLARIS_ORG_ID       — organization ID for the environment
#   polaris_api()         — convenience: polaris_api METHOD /api/path [curl args]
#
# Usage:
#   source /workspace/scripts/polaris-auth.sh cdev
#   polaris_api GET /api/auth/openid-connect/userinfo
#   # Or use curl directly:
#   curl -b "$POLARIS_COOKIES" -H "organization-id: $POLARIS_ORG_ID" \
#     "$POLARIS_BASE_URL/api/portfolios/"
#
# List available sessions:
#   source /workspace/scripts/polaris-auth.sh --list

POLARIS_SESSIONS_DIR="/workspace/global/sessions"

# ── List mode ───────────────────────────────────────────────────────

if [[ "${1:-}" == "--list" || "${1:-}" == "-l" ]]; then
  if [[ ! -d "$POLARIS_SESSIONS_DIR" ]]; then
    echo "No sessions directory found at $POLARIS_SESSIONS_DIR" >&2
    return 0 2>/dev/null || exit 0
  fi
  echo "Available Polaris sessions:"
  for f in "$POLARIS_SESSIONS_DIR"/*.json; do
    [[ -f "$f" ]] || continue
    env_name=$(basename "$f" .json)
    info=$(python3 -c "
import json
with open('$f') as fh:
    d = json.load(fh)
print(f'{d.get(\"base_url\", \"?\")}  (updated: {d.get(\"updated_at\", \"?\")})')
    " 2>/dev/null) || info="(unreadable)"
    echo "  $env_name — $info"
  done
  return 0 2>/dev/null || exit 0
fi

# ── Load session ────────────────────────────────────────────────────

POLARIS_ENV="${1:?Usage: source polaris-auth.sh <env-name>  (e.g., cdev, co, im)}"
POLARIS_SESSION_FILE="${POLARIS_SESSIONS_DIR}/${POLARIS_ENV}.json"

if [[ ! -f "$POLARIS_SESSION_FILE" ]]; then
  echo "WARNING: No session for environment '$POLARIS_ENV' at $POLARIS_SESSION_FILE" >&2
  echo "Available sessions:" >&2
  ls "$POLARIS_SESSIONS_DIR"/*.json 2>/dev/null | while read -r f; do
    echo "  $(basename "$f" .json)" >&2
  done
  POLARIS_COOKIES=""
  POLARIS_BASE_URL=""
  POLARIS_ORG_ID=""
else
  eval "$(python3 -c "
import json, sys
try:
    with open('$POLARIS_SESSION_FILE') as f:
        data = json.load(f)
    session = data.get('session_cookie', '')
    org_id = data.get('org_id', data.get('organization_id', ''))
    base_url = data.get('base_url', '')
    api_token = data.get('api_token', '')
    # Build cookie string: session + OrgId
    cookie_parts = []
    if session:
        cookie_parts.append(f'session={session}')
    if org_id:
        cookie_parts.append(f'OrgId={org_id}')
    cookie_str = '; '.join(cookie_parts)
    print(f'POLARIS_COOKIES=\"{cookie_str}\"')
    print(f'POLARIS_BASE_URL=\"{base_url}\"')
    print(f'POLARIS_ORG_ID=\"{org_id}\"')
    print(f'POLARIS_API_TOKEN=\"{api_token}\"')
except Exception as e:
    print(f'POLARIS_COOKIES=\"\"', file=sys.stdout)
    print(f'POLARIS_BASE_URL=\"\"', file=sys.stdout)
    print(f'POLARIS_ORG_ID=\"\"', file=sys.stdout)
    print(f'POLARIS_API_TOKEN=\"\"', file=sys.stdout)
    print(f'Error reading session: {e}', file=sys.stderr)
  " 2>/dev/null)"
fi

polaris_api() {
  local method="${1:?Usage: polaris_api METHOD /api/path [curl_args...]}"
  local api_path="${2:?Usage: polaris_api METHOD /api/path [curl_args...]}"
  shift 2

  # Re-read session file for fresh cookies (keepalive may have refreshed)
  local _cookies _org_id _base_url _api_token
  eval "$(python3 -c "
import json, sys
try:
    with open('${POLARIS_SESSION_FILE}') as f:
        data = json.load(f)
    session = data.get('session_cookie', '')
    org_id = data.get('org_id', data.get('organization_id', ''))
    base_url = data.get('base_url', '')
    api_token = data.get('api_token', '')
    cookie_parts = []
    if session: cookie_parts.append(f'session={session}')
    if org_id:  cookie_parts.append(f'OrgId={org_id}')
    print(f'_cookies=\"{\";\".join(cookie_parts)}\"')
    print(f'_org_id=\"{org_id}\"')
    print(f'_base_url=\"{base_url}\"')
    print(f'_api_token=\"{api_token}\"')
except Exception as e:
    print('_cookies=\"\"'); print('_org_id=\"\"')
    print('_base_url=\"\"'); print('_api_token=\"\"')
    print(f'echo \"Error reading session: {e}\" >&2')
" 2>/dev/null)"

  if [[ -z "$_cookies" && -z "$_api_token" ]]; then
    echo "ERROR: No Polaris session or API token available for '$POLARIS_ENV'" >&2
    return 1
  fi

  # Prefer API token (stable, long-lived) over session cookies (short-lived)
  # API token auth: Api-Token header, NO organization-id header (conflicts)
  # Session cookie auth: -b cookies + organization-id header (required)
  local auth_args=()
  if [[ -n "$_api_token" ]]; then
    auth_args+=(-H "Api-Token: ${_api_token}")
  else
    auth_args+=(-b "$_cookies" -H "organization-id: ${_org_id}")
  fi

  /workspace/scripts/api.sh "polaris-${POLARIS_ENV}" "$method" "${_base_url}${api_path}" \
    "${auth_args[@]}" \
    -H "x-client-source: polaris-ui" \
    "$@"
}
