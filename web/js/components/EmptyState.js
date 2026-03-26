import { html } from 'htm/preact';

export function EmptyState({ message, hint }) {
  return html`
    <div class="flex-1 flex items-center justify-center">
      <div class="text-center text-txt-2 px-6">
        <p class="text-base mb-2">${message}</p>
        ${hint && html`<p class="text-sm text-txt-muted">${hint}</p>`}
      </div>
    </div>
  `;
}
