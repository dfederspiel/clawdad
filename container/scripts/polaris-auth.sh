#!/usr/bin/env bash
# Polaris Authentication Helper — Multi-Environment
#
# Source this file with an environment name to get session cookies.
# Sessions are maintained by the host-level keepalive system and
# shared via /workspace/global/sessions/{env}.json (read-only mount).
#
# Provides:
#   $POLARIS_COOKIES    — cookie string for: curl -b "$POLARIS_COOKIES" ...
#   $POLARIS_BASE_URL   — base URL for the environment
#   $POLARIS_ENV        — environment name
#   polaris_api()       — convenience: polaris_api METHOD /api/path [curl args]
#
# Usage:
#   source /workspace/scripts/polaris-auth.sh cdev
#   curl -b "$POLARIS_COOKIES" "$POLARIS_BASE_URL/api/auth/user-info"
#   # Or:
#   polaris_api GET /api/auth/user-info
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
else
  eval "$(python3 -c "
import json, sys
try:
    with open('$POLARIS_SESSION_FILE') as f:
        data = json.load(f)
    cookies = data.get('cookies', {})
    cookie_str = '; '.join(f'{k}={v}' for k, v in cookies.items())
    base_url = data.get('base_url', '')
    print(f'POLARIS_COOKIES=\"{cookie_str}\"')
    print(f'POLARIS_BASE_URL=\"{base_url}\"')
except Exception as e:
    print(f'POLARIS_COOKIES=\"\"', file=sys.stdout)
    print(f'POLARIS_BASE_URL=\"\"', file=sys.stdout)
    print(f'Error reading session: {e}', file=sys.stderr)
  " 2>/dev/null)"
fi

polaris_api() {
  local method="${1:?Usage: polaris_api METHOD /api/path [curl_args...]}"
  local api_path="${2:?Usage: polaris_api METHOD /api/path [curl_args...]}"
  shift 2

  if [[ -z "$POLARIS_COOKIES" ]]; then
    echo "ERROR: No Polaris session available for '$POLARIS_ENV'" >&2
    return 1
  fi

  /workspace/scripts/api.sh "polaris-${POLARIS_ENV}" "$method" "${POLARIS_BASE_URL}${api_path}" \
    -b "$POLARIS_COOKIES" "$@"
}
