import { html } from 'htm/preact';

export function TableBlock({ columns, rows }) {
  if (!columns || !rows) return null;
  return html`
    <div class="table-block-wrapper">
      <table class="table-block">
        <thead>
          <tr>${columns.map(c => html`<th>${c}</th>`)}</tr>
        </thead>
        <tbody>
          ${rows.map(row => html`
            <tr>${(Array.isArray(row) ? row : columns.map(c => row[c])).map(cell =>
              html`<td>${cell}</td>`
            )}</tr>
          `)}
        </tbody>
      </table>
    </div>
  `;
}
