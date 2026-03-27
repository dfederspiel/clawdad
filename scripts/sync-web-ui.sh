#!/usr/bin/env bash
# Sync web UI channel files between nanoclaw instances.
# Usage: ./scripts/sync-web-ui.sh <target-repo>
# Example: ./scripts/sync-web-ui.sh ~/code/bd-nanoclaw

set -euo pipefail

TARGET="${1:?Usage: $0 <target-repo-path>}"
SOURCE="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -d "$TARGET/src" ]; then
  echo "Error: $TARGET doesn't look like a nanoclaw repo (no src/ dir)"
  exit 1
fi

# Files that make up the web channel
FILES=(
  web/
  src/channels/web.ts
)

echo "Syncing web UI: $SOURCE -> $TARGET"
echo ""

for f in "${FILES[@]}"; do
  if [ -d "$SOURCE/$f" ]; then
    mkdir -p "$TARGET/$f"
    rsync -av --delete "$SOURCE/$f" "$TARGET/$(dirname "$f")/"
  else
    mkdir -p "$TARGET/$(dirname "$f")"
    cp -v "$SOURCE/$f" "$TARGET/$f"
  fi
done

echo ""
echo "Done. Review changes in $TARGET with: cd $TARGET && git diff"
