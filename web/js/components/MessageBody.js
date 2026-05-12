import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { parseBlocks } from '../block-parser.js';
import { BlockRenderer } from './blocks/BlockRenderer.js';
import { md } from '../markdown.js';
import { addPin, pendingInput, pins, removePin } from '../app.js';
import { openPinsInDrawer } from './AgentPanel.js';

// #142 — Lucide pin icon (small, inline). Mirrors the one in Message.js
// so block-level and message-level pin affordances visually match.
const PinIconSmall = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3" aria-hidden="true"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>`;

function PinnableBlock({ messageId, blockId, children, disabled }) {
  const [hovered, setHovered] = useState(false);
  if (disabled) return children;
  const existingPin = Object.values(pins.value).find(
    (p) => p.message_id === messageId && p.block_id === blockId,
  );
  const onToggle = async (e) => {
    e.stopPropagation();
    if (existingPin) {
      await removePin(existingPin.thread_id);
    } else {
      await addPin({ messageId, blockId, title: `Block: ${blockId}` });
      openPinsInDrawer();
    }
  };
  return html`
    <div
      class="relative group/block"
      onMouseEnter=${() => setHovered(true)}
      onMouseLeave=${() => setHovered(false)}
    >
      ${children}
      ${(hovered || existingPin) && html`
        <button
          class="absolute top-1 right-1 z-10 flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-bg-3/95 border ${existingPin ? 'border-accent text-accent' : 'border-border text-txt-muted hover:text-accent hover:border-accent'} transition-colors shadow"
          onClick=${onToggle}
          title=${existingPin ? 'Unpin this block' : 'Pin this block to the side panel'}
        >
          ${PinIconSmall}
          <span>${existingPin ? 'pinned' : 'pin'}</span>
        </button>
      `}
    </div>
  `;
}

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
export function MessageBody({ content, messageId, messageTimestamp, blockState, singleBlockId }) {
  if (!content) return null;
  const blocks = parseBlocks(content);
  if (blocks) {
    // #142 — When the caller asks for a specific block (pin drawer view),
    // filter to that one block. Returns null when the requested block is
    // no longer in the message (block stripped from a regenerated body).
    const renderable = singleBlockId
      ? blocks
          .map((b, i) => ({ b, i, id: fallbackBlockId(b, i) }))
          .filter((x) => x.id === singleBlockId)
      : blocks.map((b, i) => ({ b, i, id: fallbackBlockId(b, i) }));
    if (renderable.length === 0) {
      return html`<div class="text-xs text-txt-muted italic">Pinned block no longer present in this message.</div>`;
    }
    // singleBlockId mode is the pin-drawer view — no nested pin affordance
    // (the pin already exists; the panel header has its own unpin button).
    const showPinAffordance = !singleBlockId && !!messageId;
    return html`
      <div class="block-container" onClick=${handleMentionClick}>
        ${renderable.map(({ b, i, id }) => {
          const overlay = blockState && blockState[id];
          const effective = overlay ? { ...b, ...overlay } : b;
          // Only offer block-level pin when the block has an explicit
          // (agent-assigned) id — content-hash ids are unstable across
          // re-emissions and would dangle if the agent regenerates.
          const hasExplicitId = b && typeof b.id === 'string' && b.id.length > 0;
          const renderedBlock = html`<${BlockRenderer}
            key=${id}
            block=${effective}
            messageId=${messageId}
            messageTimestamp=${messageTimestamp}
            blockIndex=${i}
            blockId=${id}
          />`;
          return html`<${PinnableBlock}
            key=${id}
            messageId=${messageId}
            blockId=${id}
            disabled=${!showPinAffordance || !hasExplicitId}
          >${renderedBlock}</${PinnableBlock}>`;
        })}
      </div>
    `;
  }
  return html`<div class="prose" onClick=${handleMentionClick} dangerouslySetInnerHTML=${{ __html: md(content) }} />`;
}
