import { html } from 'htm/preact';
import { md } from '../../markdown.js';

export function TextBlock({ content }) {
  return html`<div class="prose" dangerouslySetInnerHTML=${{ __html: md(content) }} />`;
}
