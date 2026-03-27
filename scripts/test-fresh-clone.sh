#!/usr/bin/env bash
# Clone a fresh copy of bd-nanoclaw for testing the first-boot experience.
# Usage: ./scripts/test-fresh-clone.sh [target-dir]

set -euo pipefail

TARGET="${1:-/tmp/test-clawdad}"

# Clean up previous test if it exists
if [ -d "$TARGET" ]; then
  echo "Removing previous test clone at $TARGET"
  rm -rf "$TARGET"
fi

git clone git@github.com:bd-polaris/bd-nanoclaw.git "$TARGET"
echo ""
echo "Fresh clone ready at: $TARGET"
echo "Run:"
echo "  cd $TARGET && claude"
echo ""
echo "Then say: help me get set up"
