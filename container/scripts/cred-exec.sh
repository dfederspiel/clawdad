#!/usr/bin/env bash
# Execute a command with a credential injected as an environment variable.
#
# Usage: cred-exec.sh <service> <env_var> -- <command...>
#
# Fetches the real credential for <service> from the credential proxy and
# sets it as <env_var> for the duration of <command>. The credential only
# exists in the child process's environment — never on disk or in the
# container's global env.
#
# Examples:
#   cred-exec.sh github GITHUB_TOKEN -- gh pr list
#   cred-exec.sh github GITHUB_TOKEN -- gh repo clone owner/repo
#   cred-exec.sh gitlab GITLAB_TOKEN -- glab mr list
#   cred-exec.sh aws AWS_SECRET_ACCESS_KEY -- aws s3 ls
#
# The proxy resolves the service name to the best matching credential
# (e.g., "github" → GITHUB_TOKEN, "atlassian" → ATLASSIAN_API_TOKEN).
#
# Exit codes:
#   0   — command succeeded
#   1   — usage error or credential fetch failed
#   *   — exit code from the wrapped command

set -euo pipefail

if [ $# -lt 4 ]; then
  echo "Usage: cred-exec.sh <service> <env_var> -- <command...>" >&2
  exit 1
fi

SERVICE="$1"
ENV_VAR="$2"
shift 2

# Consume the "--" separator
if [ "$1" != "--" ]; then
  echo "Error: expected '--' separator after env_var" >&2
  echo "Usage: cred-exec.sh <service> <env_var> -- <command...>" >&2
  exit 1
fi
shift

if [ $# -eq 0 ]; then
  echo "Error: no command specified after '--'" >&2
  exit 1
fi

# Resolve proxy URL — CRED_PROXY_URL is set by the container runner
PROXY_URL="${CRED_PROXY_URL:-}"
if [ -z "$PROXY_URL" ]; then
  echo "Error: CRED_PROXY_URL not set — are you running inside a container?" >&2
  exit 1
fi

# Fetch the real credential from the proxy
CRED_VALUE=$(curl -sf "${PROXY_URL}/credential/${SERVICE}" 2>/dev/null) || {
  echo "Error: failed to fetch credential for service '${SERVICE}'" >&2
  echo "Check that the credential is registered (use request_credential if needed)" >&2
  exit 1
}

if [ -z "$CRED_VALUE" ]; then
  echo "Error: empty credential returned for service '${SERVICE}'" >&2
  exit 1
fi

# Execute the command with the credential injected
export "${ENV_VAR}=${CRED_VALUE}"
exec "$@"
