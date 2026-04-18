import { html } from 'htm/preact';
import { useRef, useEffect, useState } from 'preact/hooks';

export function CodeBlock({ content, code, body, language, filename }) {
  content = content || code || body || '';
  const codeRef = useRef(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (codeRef.current && window.hljs) {
      window.hljs.highlightElement(codeRef.current);
    }
  }, [content]);

  const copy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const lang = language || 'plaintext';

  return html`
    <div class="code-block">
      <div class="code-block-header">
        <div class="code-block-meta">
          ${filename && html`<span class="code-block-filename pixel-badge">${filename}</span>`}
          <span class="code-block-lang">${lang}</span>
        </div>
        <button class="code-block-copy" onClick=${copy}>
          ${copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre><code ref=${codeRef} class="language-${lang}">${content}</code></pre>
    </div>
  `;
}
