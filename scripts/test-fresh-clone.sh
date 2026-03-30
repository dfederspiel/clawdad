#!/usr/bin/env bash
# Tear down any running test instance, clone a fresh copy, and print next steps.
#
# Usage:
#   ./scripts/test-fresh-clone.sh              # defaults to ~/code/clawdad-test
#   ./scripts/test-fresh-clone.sh /tmp/my-test # custom target directory
#
# What it does:
#   1. Stops and removes the service for the target directory (systemd or launchd)
#   2. Deletes the target directory
#   3. Clones a fresh copy from the current repo's remote
#   4. Prints instructions for running setup

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="${1:-$HOME/code/clawdad-test}"

# ---------------------------------------------------------------------------
# Derive the service name the same way setup/service.ts does:
#   serviceLabel = "com.nanoclaw.<dirname>"
#   systemd unit = label with dots → dashes
# ---------------------------------------------------------------------------
DIR_NAME="$(basename "$TARGET" | sed 's/[^a-zA-Z0-9_-]/-/g')"
LABEL="com.nanoclaw.${DIR_NAME}"
UNIT_NAME="${LABEL//\./-}"   # com-nanoclaw-clawdad-test

# ---------------------------------------------------------------------------
# 1. Stop and remove the service (if any)
#    Only touches services in the "com.nanoclaw.<dir>" namespace — these are
#    created by setup/service.ts for each clone. The main production service
#    (nanoclaw.service) uses a different naming scheme and is never affected.
# ---------------------------------------------------------------------------
teardown_service() {
  if [[ "$(uname)" == "Darwin" ]]; then
    local plist="$HOME/Library/LaunchAgents/${LABEL}.plist"
    if [ -f "$plist" ]; then
      echo "Stopping launchd service: $LABEL"
      launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || \
        launchctl unload "$plist" 2>/dev/null || true
      rm -f "$plist"
      echo "  Removed $plist"
    fi
  else
    local unit_file="$HOME/.config/systemd/user/${UNIT_NAME}.service"
    if [ -f "$unit_file" ]; then
      echo "Stopping systemd service: $UNIT_NAME"
      systemctl --user stop "$UNIT_NAME" 2>/dev/null || true
      systemctl --user disable "$UNIT_NAME" 2>/dev/null || true
      rm -f "$unit_file"
      systemctl --user daemon-reload 2>/dev/null || true
      echo "  Removed $unit_file"
    fi

    # Also kill any nohup-started process from this directory
    if [ -f "$TARGET/nanoclaw.pid" ]; then
      local pid
      pid=$(cat "$TARGET/nanoclaw.pid" 2>/dev/null || echo "")
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        echo "Stopping nohup process (PID $pid)"
        kill "$pid" 2>/dev/null || true
      fi
    fi
  fi
}

# Safety: refuse to tear down the source repo itself
if [ -d "$TARGET" ] && [ "$(cd "$SOURCE_ROOT" && pwd)" = "$(cd "$TARGET" && pwd)" ]; then
  echo "ERROR: Target is the source repo — refusing to tear down." >&2
  exit 1
fi

teardown_service

# ---------------------------------------------------------------------------
# 2. Remove previous test directory
# ---------------------------------------------------------------------------
if [ -d "$TARGET" ]; then
  echo "Removing $TARGET"
  rm -rf "$TARGET"
fi

# ---------------------------------------------------------------------------
# 3. Clone fresh copy
# ---------------------------------------------------------------------------
REMOTE=$(git -C "$SOURCE_ROOT" remote get-url origin 2>/dev/null || echo "")
if [ -z "$REMOTE" ]; then
  echo "ERROR: Could not determine remote URL from $SOURCE_ROOT" >&2
  exit 1
fi

echo "Cloning from $REMOTE"
git clone "$REMOTE" "$TARGET"

# ---------------------------------------------------------------------------
# 4. Print next steps
# ---------------------------------------------------------------------------
echo ""
echo "Fresh clone ready at: $TARGET"
echo ""
echo "Next steps:"
echo "  cd $TARGET && claude"
echo '  Then say: "help me get set up"'
echo ""
echo "To tear down later:"
echo "  $SOURCE_ROOT/scripts/test-fresh-clone.sh $TARGET"
