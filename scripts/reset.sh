#!/usr/bin/env bash
# Reset bd-nanoclaw to a clean template state.
# Removes all user-created state while preserving the project skeleton.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "This will remove all runtime state from bd-nanoclaw:"
echo "  - store/         (database — messages, tasks, sessions, groups)"
echo "  - data/          (IPC queues, container sessions)"
echo "  - logs/          (application logs)"
echo "  - groups/*/      (user-created groups, keeps main/ and global/)"
echo "  - dist/          (build output — will regenerate)"
echo ""
echo "Channel auth (OneCLI vault) is NOT affected."
echo ".env is NOT affected."
echo ""

if [ "${1:-}" != "--yes" ]; then
  read -rp "Continue? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# Stop the dev server if it's running from THIS project (not the main instance).
# Uses lsof to find node processes with open files in this project root.
DEV_PID=$(lsof +D "$ROOT/src" -t 2>/dev/null | head -1 || true)
if [ -n "$DEV_PID" ]; then
  echo "Stopping dev server (PID $DEV_PID)..."
  kill "$DEV_PID" 2>/dev/null || true
fi

echo "Removing store/ (database)..."
rm -rf "$ROOT/store"

echo "Removing data/ (IPC & sessions)..."
# Clear contents but keep the directory — Docker Desktop's VirtioFS mount
# becomes stale if the parent directory is deleted and recreated.
if [ -d "$ROOT/data" ]; then
  rm -rf "$ROOT/data"/*
  rm -rf "$ROOT/data"/.[!.]* 2>/dev/null || true
else
  mkdir -p "$ROOT/data"
fi

echo "Removing logs/..."
rm -rf "$ROOT/logs"

echo "Removing user-created groups..."
for dir in "$ROOT/groups"/*/; do
  name="$(basename "$dir")"
  case "$name" in
    main|global) ;; # keep template groups
    *) echo "  - groups/$name"; rm -rf "$dir" ;;
  esac
done

echo "Removing dist/ (build output)..."
rm -rf "$ROOT/dist"

echo ""
echo "Reset complete. To start fresh:"
echo "  npm run build"
echo "  npm run dev"
