#!/usr/bin/env bash
# Polaris Session Keepalive — deterministic Keycloak login and session refresh.
# Runs on the HOST (not inside a container). Called by src/polaris-session-keepalive.ts.
#
# Usage: bash scripts/polaris-session-keepalive.sh <env-name> [session-file-path]
#   env-name: environment key (e.g., cdev, co, im, stg)
#   Reads from .env: POLARIS_{ENV}_BASE_URL, POLARIS_{ENV}_EMAIL, POLARIS_{ENV}_PASSWORD
#   Optional:        POLARIS_{ENV}_REALM (Keycloak realm, e.g., QAFE)
#
# Exit codes: 0=success, 1=auth failure, 2=network error
# Outputs JSON status to stdout on the last line.

set -euo pipefail

ENV_NAME="${1:?Usage: polaris-session-keepalive.sh <env-name> [session-file-path]}"
ENV_UPPER=$(echo "$ENV_NAME" | tr '[:lower:]' '[:upper:]')
SESSION_FILE="${2:-groups/global/sessions/${ENV_NAME}.json}"

# Temp files (cleaned up on exit)
COOKIE_JAR=$(mktemp /tmp/polaris-cookies.XXXXXX)
RESPONSE_FILE=$(mktemp /tmp/polaris-response.XXXXXX)
trap 'rm -f "$COOKIE_JAR" "$RESPONSE_FILE"' EXIT

# ── Read credentials from .env ──────────────────────────────────────

ENV_FILE=".env"
read_env_var() {
  local key="$1"
  local val
  val=$(grep "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
  # Strip surrounding quotes
  val="${val#\"}"
  val="${val%\"}"
  val="${val#\'}"
  val="${val%\'}"
  echo "$val"
}

BASE_URL=$(read_env_var "POLARIS_${ENV_UPPER}_BASE_URL")
EMAIL=$(read_env_var "POLARIS_${ENV_UPPER}_EMAIL")
PASSWORD=$(read_env_var "POLARIS_${ENV_UPPER}_PASSWORD")
REALM=$(read_env_var "POLARIS_${ENV_UPPER}_REALM")

if [[ -z "$BASE_URL" ]]; then
  echo "{\"status\":\"error\",\"env\":\"${ENV_NAME}\",\"action\":\"none\",\"message\":\"POLARIS_${ENV_UPPER}_BASE_URL not found in .env\"}" >&2
  exit 1
fi

if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
  echo "{\"status\":\"error\",\"env\":\"${ENV_NAME}\",\"action\":\"none\",\"message\":\"POLARIS_${ENV_UPPER}_EMAIL or POLARIS_${ENV_UPPER}_PASSWORD not found in .env\"}" >&2
  exit 1
fi

# Derive host and URLs from base
HOST=$(echo "$BASE_URL" | sed 's|https://||')
USER_INFO_URL="${BASE_URL}/api/auth/user-info"

# Keycloak authorize URL — requires realm
if [[ -z "$REALM" ]]; then
  echo "{\"status\":\"error\",\"env\":\"${ENV_NAME}\",\"action\":\"none\",\"message\":\"POLARIS_${ENV_UPPER}_REALM not found in .env (Keycloak realm, e.g., QAFE)\"}" >&2
  exit 1
fi
AUTHORIZE_URL="${BASE_URL}/auth/realms/${REALM}/protocol/openid-connect/auth?client_id=synopsys&response_type=code&redirect_uri=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${BASE_URL}/', safe=''))")&scope=openid"

# ── Helper: build cookie string from session file ───────────────────

build_cookie_string() {
  python3 -c "
import json, sys
try:
    with open('$SESSION_FILE') as f:
        data = json.load(f)
    cookies = data.get('cookies', {})
    print('; '.join(f'{k}={v}' for k, v in cookies.items()))
except Exception:
    sys.exit(1)
  " 2>/dev/null
}

# ── Helper: parse curl cookie jar into JSON ─────────────────────────

parse_cookie_jar() {
  python3 -c "
import json, sys, datetime

cookies = {}
with open('$COOKIE_JAR') as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        parts = line.split('\t')
        if len(parts) < 7:
            continue
        domain, _, path, secure, expires, name, value = parts[:7]
        # Only keep cookies for our Polaris domain
        if '${HOST}' in domain:
            cookies[name] = value

session = {
    'env': '${ENV_NAME}',
    'base_url': '${BASE_URL}',
    'cookies': cookies,
    'domain': '${HOST}',
    'updated_at': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
    'status': 'active'
}
print(json.dumps(session, indent=2))
  "
}

# ── Step 1: Try refreshing existing session ─────────────────────────

if [[ -f "$SESSION_FILE" ]]; then
  COOKIES=$(build_cookie_string) || COOKIES=""

  if [[ -n "$COOKIES" ]]; then
    HTTP_CODE=$(curl -s -o "$RESPONSE_FILE" -w "%{http_code}" \
      -b "$COOKIES" \
      --max-time 10 \
      "$USER_INFO_URL" 2>/dev/null) || HTTP_CODE="000"

    if [[ "$HTTP_CODE" == "200" ]]; then
      # Session is still valid — update timestamp
      python3 -c "
import json, datetime
with open('$SESSION_FILE') as f:
    data = json.load(f)
data['updated_at'] = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
data['status'] = 'active'
with open('$SESSION_FILE', 'w') as f:
    json.dump(data, f, indent=2)
      "
      echo "{\"status\":\"ok\",\"env\":\"${ENV_NAME}\",\"action\":\"refreshed\"}"
      exit 0
    fi
    # Session expired — fall through to re-authenticate
  fi
fi

# ── Step 2: Re-authenticate via Keycloak ────────────────────────────

# 2a. GET the login endpoint — follows redirects to Keycloak login page
HTTP_CODE=$(curl -s -o "$RESPONSE_FILE" -w "%{http_code}" \
  -c "$COOKIE_JAR" \
  -L --max-redirs 10 \
  --max-time 15 \
  "$AUTHORIZE_URL" 2>/dev/null) || HTTP_CODE="000"

if [[ "$HTTP_CODE" == "000" ]]; then
  echo "{\"status\":\"error\",\"env\":\"${ENV_NAME}\",\"action\":\"none\",\"message\":\"Network error reaching Keycloak\"}" >&2
  exit 2
fi

# 2b. Extract the form action URL from the HTML
ACTION_URL=$(sed -n 's/.*action="\([^"]*\)".*/\1/p' "$RESPONSE_FILE" | head -1)
# Decode HTML entities (&amp; → &)
ACTION_URL=$(echo "$ACTION_URL" | sed 's/&amp;/\&/g')

if [[ -z "$ACTION_URL" ]]; then
  echo "{\"status\":\"error\",\"env\":\"${ENV_NAME}\",\"action\":\"none\",\"message\":\"Could not find Keycloak login form action URL\"}" >&2
  exit 1
fi

# 2c. POST credentials to the action URL
HTTP_CODE=$(curl -s -o "$RESPONSE_FILE" -w "%{http_code}" \
  -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
  -L --max-redirs 10 \
  --max-time 15 \
  --data-urlencode "username=${EMAIL}" \
  --data-urlencode "password=${PASSWORD}" \
  "$ACTION_URL" 2>/dev/null) || HTTP_CODE="000"

if [[ "$HTTP_CODE" == "000" ]]; then
  echo "{\"status\":\"error\",\"env\":\"${ENV_NAME}\",\"action\":\"none\",\"message\":\"Network error during login POST\"}" >&2
  exit 2
fi

# Check for login failure (Keycloak returns 200 with error on the page)
if grep -q 'Invalid username or password' "$RESPONSE_FILE" 2>/dev/null; then
  echo "{\"status\":\"error\",\"env\":\"${ENV_NAME}\",\"action\":\"none\",\"message\":\"Invalid credentials — check POLARIS_${ENV_UPPER}_EMAIL/POLARIS_${ENV_UPPER}_PASSWORD in .env\"}" >&2
  exit 1
fi

# 2d. Hit user-info to establish the app session cookie
curl -s -o /dev/null \
  -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
  --max-time 10 \
  "$USER_INFO_URL" 2>/dev/null || true

# 2e. Parse cookie jar and write session file
SESSION_JSON=$(parse_cookie_jar)

if [[ -z "$SESSION_JSON" ]]; then
  echo "{\"status\":\"error\",\"env\":\"${ENV_NAME}\",\"action\":\"none\",\"message\":\"Failed to parse cookies after login\"}" >&2
  exit 1
fi

# Ensure the directory exists
mkdir -p "$(dirname "$SESSION_FILE")"
echo "$SESSION_JSON" > "$SESSION_FILE"

echo "{\"status\":\"ok\",\"env\":\"${ENV_NAME}\",\"action\":\"re-authenticated\"}"
exit 0
