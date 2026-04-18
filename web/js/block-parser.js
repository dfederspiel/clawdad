// Parse message content into typed blocks.
// Supports :::blocks JSON fences, :::sound fences, and :::<type> shorthand
// fences (e.g. :::card, :::alert) interleaved with plain markdown.
// If no fences found, entire content becomes a single text block.

const KNOWN_BLOCK_TYPES = new Set([
  'text',
  'code',
  'alert',
  'card',
  'table',
  'stat',
  'progress',
  'action',
  'diff',
  'form',
  'sound',
  'image',
]);

// Match :::<type> optionally with {modifiers} like :::card{variant="muted"}.
// The <type> is captured; modifiers are tolerated but discarded.
const FENCE_RE = /:::([a-zA-Z][a-zA-Z0-9_-]*)(?:\{[^}\n]*\})?\n([\s\S]*?)\n:::/g;

export function parseBlocks(content) {
  if (!content) return [{ type: 'text', content: '' }];

  const blocks = [];
  let lastIndex = 0;
  let match;

  FENCE_RE.lastIndex = 0;
  while ((match = FENCE_RE.exec(content)) !== null) {
    const before = content.slice(lastIndex, match.index).trim();
    if (before) blocks.push({ type: 'text', content: before });

    const fenceType = match[1];
    const fenceBody = match[2];

    if (fenceType === 'blocks') {
      parseBlocksFence(fenceBody, blocks);
    } else if (KNOWN_BLOCK_TYPES.has(fenceType)) {
      parseTypedFence(fenceType, fenceBody, blocks);
    } else {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(
          `[block-parser] Unknown fence type :::${fenceType} — rendering as text. Use :::blocks with a JSON type field instead.`,
        );
      }
      // Render the raw fence as text so the operator can see what the agent emitted.
      blocks.push({ type: 'text', content: match[0] });
    }

    lastIndex = match.index + match[0].length;
  }

  // Text after last fence (or entire content if no fences)
  const after = content.slice(lastIndex).trim();
  if (after) blocks.push({ type: 'text', content: after });

  return blocks.length > 0 ? blocks : [{ type: 'text', content }];
}

function parseBlocksFence(body, blocks) {
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      for (const block of parsed) {
        if (block && block.type) blocks.push(block);
      }
    } else {
      warnRecovery(
        'bare-object-in-blocks-fence',
        'expected an array of blocks but got a single object — auto-wrapped. Use [{ ... }] inside :::blocks.',
      );
      if (parsed && parsed.type) blocks.push(parsed);
    }
    return;
  } catch {
    // fall through to recovery
  }
  const { blocks: recovered, strategy } = tryRecoverBareObjects(body);
  if (recovered.length > 0) {
    warnRecovery(
      strategy,
      strategy === 'wrap-in-array'
        ? 'recovered comma-separated objects by wrapping in [ ... ]. Emit a JSON array directly.'
        : 'recovered multiple bare objects by splitting on }{ boundaries. Emit a JSON array directly.',
    );
    for (const block of recovered) blocks.push(block);
  } else {
    warnRecovery(
      'unparseable-blocks-fence',
      'body is not valid JSON and could not be recovered — rendering as text.',
    );
    blocks.push({ type: 'text', content: body });
  }
}

function warnRecovery(strategy, message) {
  if (typeof console !== 'undefined' && console.warn) {
    console.warn(`[block-parser] :::blocks recovery (${strategy}): ${message}`);
  }
}

// Recovery for :::<type> shorthand: parse body as JSON and assume the fence
// type. Handles the common LLM mistake of emitting :::card { ... } instead
// of the documented :::blocks [{ "type": "card", ... }] form.
function parseTypedFence(type, body, blocks) {
  try {
    const parsed = JSON.parse(body);
    blocks.push({ ...parsed, type });
    return;
  } catch {
    // fall through
  }
  if (typeof console !== 'undefined' && console.warn) {
    console.warn(
      `[block-parser] Fence :::${type} body is not valid JSON — rendering as text.`,
    );
  }
  blocks.push({ type: 'text', content: body });
}

/**
 * Attempt to recover when LLM emits multiple bare JSON objects
 * instead of a proper array.  Tries two strategies:
 * 1. Wrap the whole body in [ ... ] (handles comma-separated objects)
 * 2. Split on }{ boundaries and parse each object individually
 *
 * Returns { blocks, strategy } where strategy is 'wrap-in-array',
 * 'split-on-boundary', or 'none' (no blocks recovered).
 */
function tryRecoverBareObjects(body) {
  // Strategy 1: wrap in brackets
  const wrapped = `[${body}]`;
  try {
    const parsed = JSON.parse(wrapped);
    if (Array.isArray(parsed)) {
      const filtered = parsed.filter((b) => b && b.type);
      if (filtered.length > 0) {
        return { blocks: filtered, strategy: 'wrap-in-array' };
      }
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
  return { blocks: results, strategy: results.length > 0 ? 'split-on-boundary' : 'none' };
}
