import { html } from 'htm/preact';
import { parseBlocks } from '../block-parser.js';
import { BlockRenderer } from './blocks/BlockRenderer.js';
import { md } from '../markdown.js';
import { pendingInput } from '../app.js';

// Mentions (@agent) in rendered markdown carry data-trigger. Clicking one
// injects the trigger into the chat input. Handled here so every surface
// (main feed, threads, drawer portals) gets the behavior automatically.
function handleMentionClick(e) {
  const mention = e.target.closest('.mention');
  if (!mention) return;
  const trigger = mention.dataset.trigger;
  if (trigger) pendingInput.value = trigger;
}

// #141 — Resolve a stable id for the block. Explicit `id` is preferred and
// is the only form that's addressable from outside the renderer (e.g. via
// agent update_block calls). Blocks without an `id` get a content-hash
// fallback so the renderer can dedup state lookups within a message but
// agents can't target them by name.
function fallbackBlockId(block, index) {
  if (block && typeof block.id === 'string' && block.id.length > 0) {
    return block.id;
  }
  // Cheap deterministic hash of a stable JSON projection. Index is mixed
  // in so two visually-identical blocks within a message stay distinct.
  let s;
  try {
    s = JSON.stringify(block);
  } catch {
    s = String(block?.type || 'text');
  }
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `auto-${index}-${(h >>> 0).toString(36)}`;
}

/**
 * Renders a message body with the same rich content pipeline used
 * everywhere (main feed, threads, drawer portals, future multi-panel).
 * Prefers structured block rendering when the content parses as blocks,
 * falls back to markdown for plain text. Keep this the single path for
 * message content so new surfaces get the same behavior for free.
 *
 * messageId and messageTimestamp flow down so blocks like SoundBlock
 * can gate side-effects (playback) on per-instance identity instead of
 * firing every time the surface re-renders (#99).
 *
 * blockState (#141) is a `{ [blockId]: state }` map the orchestrator
 * keeps for each message. We shallow-merge it over each block payload
 * before passing to BlockRenderer so renderers see the latest values.
 */
export function MessageBody({ content, messageId, messageTimestamp, blockState }) {
  if (!content) return null;
  const blocks = parseBlocks(content);
  if (blocks) {
    return html`
      <div class="block-container" onClick=${handleMentionClick}>
        ${blocks.map((block, i) => {
          const blockId = fallbackBlockId(block, i);
          const overlay = blockState && blockState[blockId];
          const effective = overlay ? { ...block, ...overlay } : block;
          return html`<${BlockRenderer}
            key=${blockId}
            block=${effective}
            messageId=${messageId}
            messageTimestamp=${messageTimestamp}
            blockIndex=${i}
            blockId=${blockId}
          />`;
        })}
      </div>
    `;
  }
  return html`<div class="prose" onClick=${handleMentionClick} dangerouslySetInnerHTML=${{ __html: md(content) }} />`;
}
