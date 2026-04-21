#!/usr/bin/env bash
#
# Clone all Polaris backend service repos from GitLab into ~/code/backend-services/.
# Idempotent — skips repos already cloned. Pulls main/master on existing repos.
#
# Usage: ./scripts/clone-backend-services.sh
#
# Requires GITLAB_URL and GITLAB_TOKEN in .env (or environment).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TARGET_DIR="$HOME/code/backend-services"

# Load .env if present
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_ROOT/.env"
  set +a
fi

if [[ -z "${GITLAB_URL:-}" ]]; then
  echo "ERROR: GITLAB_URL not set. Add it to .env (e.g., https://gitlab.tools.duckutil.net)"
  exit 1
fi

if [[ -z "${GITLAB_TOKEN:-}" ]]; then
  echo "ERROR: GITLAB_TOKEN not set. Add it to .env"
  exit 1
fi

# Strip trailing slash from GITLAB_URL
GITLAB_URL="${GITLAB_URL%/}"

mkdir -p "$TARGET_DIR"

# Service definitions: local_dir gitlab_path default_branch
# Sourced from groups/web_bug-squad/memory/reference_backend_services.md
SERVICES=(
  "portfolio-service      altair/altair-portfolio-service/server             master"
  "test-service           altair/test-service/server                         master"
  "ciam-service           altair/IAM/ciam-service                            master"
  "entitlement-manager    altair/altair-entitlement-manager/server           master"
  "tenant-manager         altair/altair-tenant-manager/server                master"
  "scan-manager           altair/altair-scan-manager/server                  master"
  "storage-service        altair/storage-service/server                      master"
  "tool-service           altair/altair-tool-service/server                  master"
  "issue-export-service   altair/altair-issue-export/issue-export-service    master"
  "notification-service   altair/notification/notification-service           master"
  "audit-service          altair/audit/audit-service                         master"
  "report-service         altair/report/report-service                       master"
  "scm-integrations       altair/scm/altair-scm-integrations                master"
  "scm-runner             altair/scm/altair-scm-runner                      master"
  "scan-runner            altair/altair-scan-manager/scan-runner             master"
)

cloned=0
updated=0
failed=0

for entry in "${SERVICES[@]}"; do
  read -r dir_name gitlab_path default_branch <<< "$entry"
  repo_dir="$TARGET_DIR/$dir_name"

  if [[ -d "$repo_dir/.git" ]]; then
    echo "--- Updating $dir_name (already cloned)"
    cd "$repo_dir"
    current_branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "detached")
    if [[ "$current_branch" != "$default_branch" && "$current_branch" != "main" ]]; then
      echo "    WARNING: on branch '$current_branch', switching to $default_branch"
      git checkout "$default_branch" 2>/dev/null || git checkout main 2>/dev/null || true
    fi
    if git pull --ff-only 2>/dev/null; then
      ((updated++))
    else
      echo "    WARNING: pull failed (maybe rebased upstream?), resetting to origin"
      git fetch origin
      git reset --hard "origin/$default_branch" 2>/dev/null || git reset --hard origin/main 2>/dev/null || true
      ((updated++))
    fi
    continue
  fi

  echo "+++ Cloning $dir_name from $gitlab_path"
  clone_url="https://oauth2:${GITLAB_TOKEN}@${GITLAB_URL#https://}/${gitlab_path}.git"

  if git clone --depth=1 "$clone_url" "$repo_dir" 2>/dev/null; then
    ((cloned++))
  else
    echo "    ERROR: clone failed for $dir_name"
    ((failed++))
  fi
done

echo ""
echo "Done. Cloned: $cloned, Updated: $updated, Failed: $failed"
echo "Backend services are at: $TARGET_DIR"

if ((failed > 0)); then
  echo ""
  echo "Some repos failed to clone. Check GITLAB_TOKEN permissions and repo paths."
  exit 1
fi
