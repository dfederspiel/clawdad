#!/usr/bin/env bash
# Run a git command across all user-created group repos.
#
# Usage:
#   scripts/groups-git.sh status        # git status in each group
#   scripts/groups-git.sh push          # push all groups
#   scripts/groups-git.sh log --oneline -5
#   scripts/groups-git.sh diff
#   scripts/groups-git.sh commit -am "update memory"
#   scripts/groups-git.sh <any git subcommand>
#   scripts/groups-git.sh sweep        # auto-ignore cloned repos (nested .git dirs)
#
# With no arguments, shows a summary (dirty/clean, remote tracking).
set -euo pipefail

GROUPS_DIR="$(cd "$(dirname "$0")/../groups" && pwd)"
SKIP_GROUPS="main global global-web"

# sweep: find nested git repos (agent clones) and add them to .gitignore
sweep_cloned_repos() {
  local group_dir="$1"
  local name=$(basename "$group_dir")
  local found=0
  # Find directories containing .git that aren't the group root
  while IFS= read -r nested_git; do
    repo_dir=$(dirname "$nested_git")
    repo_name="${repo_dir#"$group_dir"}"
    # Check if already in .gitignore
    if ! grep -qxF "$repo_name/" "$group_dir/.gitignore" 2>/dev/null; then
      echo "$repo_name/" >> "$group_dir/.gitignore"
      echo "  ignore: $name/$repo_name/ (cloned repo)"
      found=1
    fi
  done < <(find "$group_dir" -mindepth 2 -name .git -not -path "$group_dir/.git/*")
  return $found
}

if [ "${1:-}" = "sweep" ]; then
  echo "Scanning for cloned repos to gitignore..."
  for group_dir in "$GROUPS_DIR"/*/; do
    name=$(basename "$group_dir")
    echo "$SKIP_GROUPS" | grep -qw "$name" && continue
    [ ! -d "$group_dir/.git" ] && continue
    sweep_cloned_repos "$group_dir" || true
  done
  echo "Done."
  exit 0
fi

if [ $# -eq 0 ]; then
  # Summary mode
  printf "%-35s %-10s %-10s %s\n" "GROUP" "STATUS" "REMOTE" "BRANCH"
  printf "%-35s %-10s %-10s %s\n" "-----" "------" "------" "------"
  for group_dir in "$GROUPS_DIR"/*/; do
    name=$(basename "$group_dir")
    echo "$SKIP_GROUPS" | grep -qw "$name" && continue
    [ ! -d "$group_dir/.git" ] && continue

    branch=$(git -C "$group_dir" branch --show-current 2>/dev/null || echo "???")
    remote=$(git -C "$group_dir" remote get-url origin 2>/dev/null || echo "none")
    if [ -n "$(git -C "$group_dir" status --porcelain 2>/dev/null)" ]; then
      status="dirty"
    else
      status="clean"
    fi
    printf "%-35s %-10s %-10s %s\n" "$name" "$status" "$remote" "$branch"
  done
  exit 0
fi

# Pass-through mode: run git <args> in each group
for group_dir in "$GROUPS_DIR"/*/; do
  name=$(basename "$group_dir")
  echo "$SKIP_GROUPS" | grep -qw "$name" && continue
  [ ! -d "$group_dir/.git" ] && continue

  echo "=== $name ==="
  git -C "$group_dir" "$@" || true
  echo ""
done
