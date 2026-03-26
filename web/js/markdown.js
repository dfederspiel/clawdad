// Minimal markdown to HTML
export function md(text) {
  if (!text) return '';
  let h = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Code blocks
  h = h.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`);

  // Inline code
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold / italic
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

  // Links
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Lists
  h = h.replace(/^- (.+)$/gm, '<li>$1</li>');
  h = h.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);

  // Line breaks (not inside pre)
  const parts = h.split(/(<pre>[\s\S]*?<\/pre>)/g);
  return parts.map((p, i) => i % 2 === 1 ? p : p.replace(/\n/g, '<br>')).join('');
}
