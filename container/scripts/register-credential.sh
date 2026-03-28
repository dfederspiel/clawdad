#!/usr/bin/env bash
# Register a credential with the host's OneCLI vault via IPC.
# The credential is written to a temporary file, picked up by the host,
# registered in the vault, and then deleted. The secret never touches disk
# permanently — it's in-flight for at most one IPC poll cycle (~2s).
#
# Usage:
#   register-credential.sh <SERVICE> <VALUE> [OPTIONS]
#
# Required:
#   SERVICE   Service name: atlassian, gitlab, github, harness, launchdarkly
#   VALUE     The API token / PAT / key
#
# Options:
#   --email EMAIL         Email for Atlassian basic auth (required for atlassian)
#   --host-pattern PAT    Override default host pattern (e.g., "gitlab.mycompany.com")
#   --name NAME           Override default secret name
#   --wait                Wait for result (up to 30s)
#
# Examples:
#   register-credential.sh atlassian "my-pat-token" --email "user@example.com"
#   register-credential.sh gitlab "glpat-xxxx" --host-pattern "gitlab.mycompany.com"
#   register-credential.sh github "ghp_xxxx" --wait

set -euo pipefail

IPC_DIR="/workspace/ipc/credentials"
mkdir -p "$IPC_DIR"

SERVICE="${1:?Usage: register-credential.sh SERVICE VALUE [--email EMAIL] [--host-pattern PAT] [--name NAME] [--wait]}"
VALUE="${2:?Usage: register-credential.sh SERVICE VALUE [--email EMAIL] [--host-pattern PAT] [--name NAME] [--wait]}"
shift 2

EMAIL=""
HOST_PATTERN=""
SECRET_NAME=""
WAIT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --email) EMAIL="$2"; shift 2 ;;
    --host-pattern) HOST_PATTERN="$2"; shift 2 ;;
    --name) SECRET_NAME="$2"; shift 2 ;;
    --wait) WAIT=true; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Validate service
case "$SERVICE" in
  atlassian|gitlab|github|harness|launchdarkly|brave) ;;
  *) echo "Unknown service: $SERVICE (valid: atlassian, gitlab, github, harness, launchdarkly, brave)" >&2; exit 1 ;;
esac

# Atlassian requires email
if [[ "$SERVICE" == "atlassian" && -z "$EMAIL" ]]; then
  echo "Error: --email is required for atlassian service" >&2
  exit 1
fi

# Build JSON payload
PAYLOAD=$(python3 -c "
import json, sys
data = {'service': '$SERVICE', 'value': sys.stdin.read().strip()}
email = '$EMAIL'
host = '$HOST_PATTERN'
name = '$SECRET_NAME'
if email: data['email'] = email
if host: data['hostPattern'] = host
if name: data['name'] = name
print(json.dumps(data))
" <<< "$VALUE")

# Write IPC file
TIMESTAMP=$(date +%s%N)
IPC_FILE="${IPC_DIR}/${SERVICE}-${TIMESTAMP}.json"
echo "$PAYLOAD" > "$IPC_FILE"
echo "Credential registration request sent for ${SERVICE}."

# Optionally wait for result
if [[ "$WAIT" == "true" ]]; then
  RESULT_FILE="${IPC_DIR}/result-${SERVICE}.json"
  # Clean any stale result
  rm -f "$RESULT_FILE" 2>/dev/null

  for i in $(seq 1 15); do
    sleep 2
    if [[ -f "$RESULT_FILE" ]]; then
      RESULT=$(cat "$RESULT_FILE")
      rm -f "$RESULT_FILE"
      SUCCESS=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success', False))")
      MESSAGE=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message', 'Unknown'))")
      if [[ "$SUCCESS" == "True" ]]; then
        echo "SUCCESS: $MESSAGE"
        exit 0
      else
        echo "FAILED: $MESSAGE" >&2
        exit 1
      fi
    fi
  done
  echo "TIMEOUT: No response from host after 30s. The credential may still be processing." >&2
  exit 1
fi
