#!/usr/bin/env bash
# Build auth arguments for curl based on available credentials.
# The credential proxy injects Anthropic credentials automatically.
# When service env vars are set, pass them explicitly to curl.
#
# Usage:
#   source /workspace/scripts/auth-args.sh
#   curl ... $(gitlab_auth) ...
#   curl ... $(github_token) ...
#
# Each function prints space-separated curl args, or nothing if the var is unset.

gitlab_auth() {
  [[ -n "${GITLAB_TOKEN:-}" ]] && echo "-H" "PRIVATE-TOKEN: $GITLAB_TOKEN"
}

launchdarkly_auth() {
  [[ -n "${LAUNCHDARKLY_API_KEY:-}" ]] && echo "-H" "Authorization: $LAUNCHDARKLY_API_KEY"
}

github_token() {
  # For GH_TOKEN env var used by gh CLI
  [[ -n "${GITHUB_TOKEN:-}" ]] && echo "$GITHUB_TOKEN"
}
