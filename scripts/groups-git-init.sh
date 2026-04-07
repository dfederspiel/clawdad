#!/usr/bin/env bash
# Initialize standalone git repos for user-created groups.
# Skips template groups (main, global, global-web) and groups that already have a .git dir.
set -euo pipefail

GROUPS_DIR="$(cd "$(dirname "$0")/../groups" && pwd)"
TEMPLATE="$GROUPS_DIR/.group-gitignore"
SKIP_GROUPS="main global global-web"

for group_dir in "$GROUPS_DIR"/*/; do
  name=$(basename "$group_dir")

  # Skip template groups
  if echo "$SKIP_GROUPS" | grep -qw "$name"; then
    echo "skip: $name (template group)"
    continue
  fi

  # Skip if already a git repo
  if [ -d "$group_dir/.git" ]; then
    echo "skip: $name (already has .git)"
    continue
  fi

  echo "init: $name"
  git -C "$group_dir" init -b main
  cp "$TEMPLATE" "$group_dir/.gitignore"

  # Auto-ignore any cloned repos (nested .git dirs) before first commit
  while IFS= read -r nested_git; do
    repo_dir=$(dirname "$nested_git")
    repo_name="${repo_dir#"$group_dir"}"
    echo "$repo_name/" >> "$group_dir/.gitignore"
    echo "  ignore: $name/$repo_name/ (cloned repo)"
  done < <(find "$group_dir" -mindepth 2 -name .git -not -path "$group_dir/.git/*")

  git -C "$group_dir" add -A
  git -C "$group_dir" commit -m "initial commit"
done

echo ""
echo "Done. Use scripts/groups-git.sh to manage all group repos."
