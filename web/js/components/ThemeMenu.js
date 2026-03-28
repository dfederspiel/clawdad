import { html } from 'htm/preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { currentTheme, setTheme, exportTheme, importTheme, removeCustomTheme, getAllThemes } from '../app.js';
import { getThemeByName } from '../themes.js';

export function ThemeMenu({ open, onClose }) {
  const menuRef = useRef(null);
  const fileRef = useRef(null);
  const [error, setError] = useState(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
    };
    setTimeout(() => document.addEventListener('click', handler), 0);
    return () => document.removeEventListener('click', handler);
  }, [open]);

  if (!open) return null;

  const themes = getAllThemes();
  const active = currentTheme.value;

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setError(null);
      await importTheme(file);
      onClose();
    } catch (err) {
      setError(err.message);
    }
    e.target.value = '';
  };

  const handleExport = () => {
    exportTheme();
    onClose();
  };

  return html`
    <div ref=${menuRef}
      class="absolute left-0 top-full mt-1 z-50 w-52 rounded-lg border border-border bg-bg-2 shadow-xl py-1"
    >
      <div class="px-3 py-1.5 text-[10px] uppercase tracking-wider text-txt-muted">Themes</div>
      ${themes.map((t) => html`
        <button
          key=${t.name}
          class="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-txt hover:bg-bg-hover transition-colors"
          onClick=${() => { setTheme(t.name); onClose(); }}
        >
          <span
            class="w-3.5 h-3.5 rounded-full border border-border flex-shrink-0"
            style=${{ background: `linear-gradient(135deg, ${t.colors.bg} 50%, ${t.colors.accent} 50%)` }}
          />
          <span class="flex-1 text-left">${t.label}</span>
          ${t.name === active && html`
            <svg class="w-3.5 h-3.5 text-accent" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
            </svg>
          `}
          ${!getThemeByName(t.name) && html`
            <span
              class="w-5 h-5 flex items-center justify-center rounded text-txt-muted hover:text-err hover:bg-bg-hover transition-colors"
              title="Remove theme"
              onClick=${(e) => { e.stopPropagation(); removeCustomTheme(t.name); }}
            >
              <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
              </svg>
            </span>
          `}
        </button>
      `)}

      <div class="border-t border-border my-1"></div>

      <button
        class="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-txt-2 hover:bg-bg-hover hover:text-txt transition-colors"
        onClick=${() => fileRef.current?.click()}
      >
        <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM6.293 6.707a1 1 0 010-1.414l3-3a1 1 0 011.414 0l3 3a1 1 0 01-1.414 1.414L11 5.414V13a1 1 0 11-2 0V5.414L7.707 6.707a1 1 0 01-1.414 0z" clip-rule="evenodd"/>
        </svg>
        Import Theme
      </button>
      <input ref=${fileRef} type="file" accept=".json" class="hidden" onChange=${handleImport} />

      <button
        class="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-txt-2 hover:bg-bg-hover hover:text-txt transition-colors"
        onClick=${handleExport}
      >
        <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd"/>
        </svg>
        Export Theme
      </button>

      ${error && html`
        <div class="px-3 py-1.5 text-xs text-err">${error}</div>
      `}
    </div>
  `;
}
