import { html } from 'htm/preact';

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function DiffBlock({ content, body, filename }) {
  const lines = (content || body || '').split('\n');

  return html`
    <div class="diff-block">
      ${filename && html`<div class="diff-header pixel-badge">${filename}</div>`}
      <pre class="diff-pre">${lines.map(line => {
        let cls = 'diff-ctx';
        if (line.startsWith('+')) cls = 'diff-add';
        else if (line.startsWith('-')) cls = 'diff-del';
        else if (line.startsWith('@@')) cls = 'diff-hunk';
        return html`<div class="${cls}">${esc(line)}</div>`;
      })}</pre>
    </div>
  `;
}
