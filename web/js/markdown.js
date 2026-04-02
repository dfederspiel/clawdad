// Markdown to HTML renderer — no dependencies, regex-based.
// Handles: code blocks, inline code, bold, italic, strikethrough,
// links, headers, tables, ordered/unordered lists, checkboxes, hr, line breaks.

export function md(text) {
  if (!text) return '';
  let h = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Code blocks (fenced with optional language)
  h = h.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code class="language-${lang || 'plaintext'}">${code.trim()}</code></pre>`);

  // Inline code
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Tables (pipe-delimited: header | sep | rows)
  // Split cells by pipe but preserve empty cells (don't filter them out).
  // Slice off first/last to discard the empty strings from leading/trailing pipes.
  const splitRow = (row) => row.split('|').slice(1, -1).map(c => c.trim());
  h = h.replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)*)/gm, (_, header, _sep, body) => {
    const thCells = splitRow(header).map(c => `<th>${c}</th>`).join('');
    const rows = body.trim().split('\n').map(row => {
      const cells = splitRow(row).map(c => `<td>${c}</td>`).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    return `<table><thead><tr>${thCells}</tr></thead><tbody>${rows}</tbody></table>`;
  });

  // Horizontal rules
  h = h.replace(/^---+$/gm, '<hr>');

  // Headers (# through ###)
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold / italic / strikethrough
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  h = h.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Links
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // @mentions — render as styled, clickable pills (skip inside code/pre)
  h = h.replace(/(^|[\s>])(@\w[\w-]*)/g, '$1<span class="mention" data-trigger="$2">$2</span>');

  // Checkboxes (must come before regular lists)
  h = h.replace(/^- \[x\] (.+)$/gm, '<li class="cb checked"><input type="checkbox" checked disabled> $1</li>');
  h = h.replace(/^- \[ \] (.+)$/gm, '<li class="cb"><input type="checkbox" disabled> $1</li>');

  // Unordered lists (support indented/nested items with 2+ leading spaces)
  h = h.replace(/^ {2,}- (.+)$/gm, '<li class="nested">$1</li>');
  h = h.replace(/^- (.+)$/gm, '<li>$1</li>');
  h = h.replace(/(<li[^>]*>.*<\/li>\n?)+/g, (m) => {
    const tag = m.includes('class="cb') ? 'ul class="checklist"' : 'ul';
    return `<${tag}>${m}</ul>`;
  });

  // Ordered lists
  h = h.replace(/^\d+\. (.+)$/gm, '<oli>$1</oli>');
  h = h.replace(/(<oli>.*<\/oli>\n?)+/g, (m) => {
    const items = m.replace(/<oli>/g, '<li>').replace(/<\/oli>/g, '</li>');
    return `<ol>${items}</ol>`;
  });

  // Line breaks — skip newlines adjacent to block-level elements
  const parts = h.split(/(<pre>[\s\S]*?<\/pre>)/g);
  return parts.map((p, i) => {
    if (i % 2 === 1) return p; // inside <pre>, leave as-is
    // Remove newlines directly before/after block elements (they have their own spacing)
    p = p.replace(/\n*(<\/?(?:h[1-3]|ul|ol|li|table|thead|tbody|tr|th|td|hr|blockquote)[^>]*>)\n*/g, '$1');
    // Collapse runs of 2+ newlines into a single paragraph break
    p = p.replace(/\n{2,}/g, '<br><br>');
    // Single newlines become single line breaks
    p = p.replace(/\n/g, '<br>');
    return p;
  }).join('');
}
