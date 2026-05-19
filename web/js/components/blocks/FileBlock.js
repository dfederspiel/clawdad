import { html } from 'htm/preact';

// MIME → short label + lucide-ish glyph for the card icon. Falls back
// to a generic file icon so unknown types still render.
const TYPE_META = {
  pdf: { label: 'PDF', match: (m) => m === 'application/pdf' },
  json: { label: 'JSON', match: (m) => m === 'application/json' },
  xml: { label: 'XML', match: (m) => m === 'application/xml' },
  yaml: {
    label: 'YAML',
    match: (m) => m === 'application/x-yaml' || m === 'application/yaml',
  },
  csv: { label: 'CSV', match: (m) => m === 'text/csv' },
  md: { label: 'MD', match: (m) => m === 'text/markdown' },
  docx: {
    label: 'DOCX',
    match: (m) =>
      m ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  text: { label: 'TXT', match: (m) => m.startsWith('text/') },
};

function classifyMime(mimeType) {
  if (!mimeType) return { label: 'FILE' };
  for (const key of Object.keys(TYPE_META)) {
    if (TYPE_META[key].match(mimeType)) return TYPE_META[key];
  }
  return { label: 'FILE' };
}

// Simple paperclip-ish glyph; intentionally stroke-based so it sits with
// the existing icon style in the app.
const FileGlyph = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5" aria-hidden="true">
  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
  <polyline points="14 2 14 8 20 8"/>
</svg>`;

export function FileBlock({ src, filename, mimeType, caption }) {
  const meta = classifyMime(mimeType);
  const displayName = filename || 'file';
  return html`
    <div class="my-3">
      <a
        href=${src}
        download=${displayName}
        target="_blank"
        rel="noopener noreferrer"
        class="flex items-center gap-3 p-3 rounded-xl border border-border bg-bg-2 hover:border-accent/40 transition-colors no-underline"
      >
        <div class="shrink-0 w-10 h-10 rounded-md bg-bg-3 flex items-center justify-center text-txt-2">
          ${FileGlyph}
        </div>
        <div class="min-w-0 flex-1">
          <div class="text-sm text-txt font-medium truncate">${displayName}</div>
          <div class="text-[10px] text-txt-muted font-mono mt-0.5">
            ${meta.label}${mimeType && ` · ${mimeType}`}
          </div>
        </div>
        <div class="shrink-0 text-[10px] text-txt-muted font-mono uppercase tracking-wider">
          download
        </div>
      </a>
      ${caption && html`<div class="mt-2 text-xs text-txt-muted">${caption}</div>`}
    </div>
  `;
}
