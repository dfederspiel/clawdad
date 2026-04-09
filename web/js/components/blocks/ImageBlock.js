import { html } from 'htm/preact';
import { useState } from 'preact/hooks';

export function ImageBlock({ src, alt, caption }) {
  const [open, setOpen] = useState(false);

  return html`
    <div class="my-3">
      <button
        type="button"
        class="block w-full text-left rounded-xl overflow-hidden border border-border bg-bg-2 hover:border-accent/40 transition-colors"
        onClick=${() => setOpen(true)}
      >
        <img
          src=${src}
          alt=${alt || caption || 'Image'}
          class="block w-full h-auto max-h-[28rem] object-contain bg-bg"
          loading="lazy"
        />
      </button>
      ${caption && html`<div class="mt-2 text-xs text-txt-muted">${caption}</div>`}

      ${open && html`
        <div
          class="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center p-4"
          onClick=${() => setOpen(false)}
        >
          <div class="max-w-6xl max-h-full" onClick=${(e) => e.stopPropagation()}>
            <img
              src=${src}
              alt=${alt || caption || 'Image'}
              class="block max-w-full max-h-[85vh] object-contain rounded-xl shadow-2xl"
            />
            <div class="mt-3 flex items-center justify-between gap-4 text-xs text-white/85">
              <div>${caption || alt || ''}</div>
              <button
                type="button"
                class="px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 transition-colors"
                onClick=${() => setOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      `}
    </div>
  `;
}
