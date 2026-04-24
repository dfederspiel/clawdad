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

/**
 * Renders a message body with the same rich content pipeline used
 * everywhere (main feed, threads, drawer portals, future multi-panel).
 * Prefers structured block rendering when the content parses as blocks,
 * falls back to markdown for plain text. Keep this the single path for
 * message content so new surfaces get the same behavior for free.
 */
export function MessageBody({ content }) {
  if (!content) return null;
  const blocks = parseBlocks(content);
  if (blocks) {
    return html`
      <div class="block-container" onClick=${handleMentionClick}>
        ${blocks.map((block, i) => html`<${BlockRenderer} key=${i} block=${block} />`)}
      </div>
    `;
  }
  return html`<div class="prose" onClick=${handleMentionClick} dangerouslySetInnerHTML=${{ __html: md(content) }} />`;
}
