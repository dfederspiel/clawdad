#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-container}"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

# Invalidate warm pool source caches — containers compile agent-runner
# from cached TypeScript in data/sessions/*/agent-runner-src/. Without
# clearing these, rebuilt images still serve stale code.
DATA_DIR="${SCRIPT_DIR}/../data/sessions"
if [ -d "$DATA_DIR" ]; then
  CLEARED=$(find "$DATA_DIR" -name "agent-runner-src" -type d 2>/dev/null | wc -l)
  find "$DATA_DIR" -name "agent-runner-src" -type d -exec rm -rf {} + 2>/dev/null
  if [ "$CLEARED" -gt 0 ]; then
    echo "Cleared ${CLEARED} cached agent-runner source dir(s)"
  fi
fi

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
