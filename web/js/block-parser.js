// Parse message content into typed blocks.
// Supports :::blocks JSON fences and :::sound fences interleaved with plain markdown.
// If no fences found, entire content becomes a single text block.

const FENCE_RE = /:::(blocks|sound)\n([\s\S]*?)\n:::/g;

export function parseBlocks(content) {
  if (!content) return [{ type: 'text', content: '' }];

  const blocks = [];
  let lastIndex = 0;
  let match;

  FENCE_RE.lastIndex = 0;
  while ((match = FENCE_RE.exec(content)) !== null) {
    // Text before this fence
    const before = content.slice(lastIndex, match.index).trim();
    if (before) blocks.push({ type: 'text', content: before });

    const fenceType = match[1]; // 'blocks' or 'sound'
    const fenceBody = match[2];

    if (fenceType === 'sound') {
      // Sound block — parse JSON for tone name or custom definition
      try {
        const parsed = JSON.parse(fenceBody);
        blocks.push({ type: 'sound', ...parsed });
      } catch {
        // Invalid JSON — render as text
        blocks.push({ type: 'text', content: fenceBody });
      }
    } else {
      // Regular blocks
      try {
        const parsed = JSON.parse(fenceBody);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const block of arr) {
          if (block && block.type) {
            blocks.push(block);
          }
        }
      } catch {
        // Invalid JSON — render as text
        blocks.push({ type: 'text', content: fenceBody });
      }
    }

    lastIndex = match.index + match[0].length;
  }

  // Text after last fence (or entire content if no fences)
  const after = content.slice(lastIndex).trim();
  if (after) blocks.push({ type: 'text', content: after });

  return blocks.length > 0 ? blocks : [{ type: 'text', content }];
}
