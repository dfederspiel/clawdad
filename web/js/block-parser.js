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
        // JSON.parse failed — attempt recovery for common LLM mistakes:
        // multiple bare objects not wrapped in an array, or objects
        // separated by blank lines.
        const recovered = tryRecoverBareObjects(fenceBody);
        if (recovered.length > 0) {
          for (const block of recovered) blocks.push(block);
        } else {
          blocks.push({ type: 'text', content: fenceBody });
        }
      }
    }

    lastIndex = match.index + match[0].length;
  }

  // Text after last fence (or entire content if no fences)
  const after = content.slice(lastIndex).trim();
  if (after) blocks.push({ type: 'text', content: after });

  return blocks.length > 0 ? blocks : [{ type: 'text', content }];
}

/**
 * Attempt to recover when LLM emits multiple bare JSON objects
 * instead of a proper array.  Tries two strategies:
 * 1. Wrap the whole body in [ ... ] (handles comma-separated objects)
 * 2. Split on }{ boundaries and parse each object individually
 */
function tryRecoverBareObjects(body) {
  // Strategy 1: wrap in brackets
  const wrapped = `[${body}]`;
  try {
    const parsed = JSON.parse(wrapped);
    if (Array.isArray(parsed)) {
      return parsed.filter((b) => b && b.type);
    }
  } catch {
    // fall through
  }

  // Strategy 2: split on }...{ boundaries (handles newline-separated objects)
  const results = [];
  const objectPattern = /\{[\s\S]*?\}(?=\s*(\{|$))/g;
  let m;
  while ((m = objectPattern.exec(body)) !== null) {
    try {
      const obj = JSON.parse(m[0]);
      if (obj && obj.type) results.push(obj);
    } catch {
      // skip unparseable chunk
    }
  }
  return results;
}
