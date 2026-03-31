import { html } from 'htm/preact';
import { md } from '../../markdown.js';

function Cell({ tag, children }) {
  // Render markdown inside table cells so links, bold, etc. work
  const content = String(children ?? '');
  const hasMarkdown = /[[\]*_~`]/.test(content);
  if (hasMarkdown) {
    return html`<${tag} dangerouslySetInnerHTML=${{ __html: md(content) }} />`;
  }
  return html`<${tag}>${content}</${tag}>`;
}

export function TableBlock({ columns, rows }) {
  if (!columns || !rows) return null;
  return html`
    <div class="table-block-wrapper">
      <table class="table-block">
        <thead>
          <tr>${columns.map(c => html`<${Cell} tag="th">${c}</${Cell}>`)}</tr>
        </thead>
        <tbody>
          ${rows.map(row => html`
            <tr>${(Array.isArray(row) ? row : columns.map(c => row[c])).map(cell =>
              html`<${Cell} tag="td">${cell}</${Cell}>`
            )}</tr>
          `)}
        </tbody>
      </table>
    </div>
  `;
}
