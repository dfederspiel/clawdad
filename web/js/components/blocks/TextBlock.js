import { html } from 'htm/preact';
import { md } from '../../markdown.js';

export function TextBlock({ content, body }) {
  return html`<div class="prose" dangerouslySetInnerHTML=${{ __html: md(content || body || '') }} />`;
}
