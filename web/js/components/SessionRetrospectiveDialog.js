import { html } from 'htm/preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { contextPressure } from '../app.js';

/**
 * Multi-step session retrospective dialog.
 * Replaces the native confirm() for session reset.
 *
 * Steps: summary → capture (with AI suggestions) → resetting
 */
export function SessionRetrospectiveDialog({ open, groupFolder, jid, onClose }) {
  const dialogRef = useRef(null);
  const [view, setView] = useState('summary'); // 'summary' | 'capture' | 'resetting'
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [claudeMdOpen, setClaudeMdOpen] = useState(false);

  // Reflection state
  const [suggestions, setSuggestions] = useState([]); // [{text, category, checked}]
  const [reflecting, setReflecting] = useState(false);
  const [reflectDone, setReflectDone] = useState(false);
  const [customNote, setCustomNote] = useState('');

  useEffect(() => {
    if (open) {
      if (dialogRef.current && !dialogRef.current.open) {
        dialogRef.current.showModal();
      }
      setView('summary');
      setSuggestions([]);
      setReflecting(false);
      setReflectDone(false);
      setCustomNote('');
      setError('');
      setClaudeMdOpen(false);
      fetchSummary();
    } else if (dialogRef.current?.open) {
      dialogRef.current.close();
    }
  }, [open]);

  async function fetchSummary() {
    setLoading(true);
    try {
      const res = await fetch(`/api/session/summary/${encodeURIComponent(groupFolder)}`);
      if (!res.ok) throw new Error('Failed to load session summary');
      setSummary(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function fetchReflection() {
    setReflecting(true);
    try {
      const res = await fetch(`/api/session/reflect/${encodeURIComponent(groupFolder)}`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Reflection failed');
      const data = await res.json();
      setSuggestions(
        (data.suggestions || []).map((s) => ({ ...s, checked: true })),
      );
    } catch (err) {
      console.warn('Reflection failed:', err);
      // Non-fatal — user can still add custom notes
    } finally {
      setReflecting(false);
      setReflectDone(true);
    }
  }

  function goToCapture() {
    setView('capture');
    if (!reflectDone) fetchReflection();
  }

  function toggleSuggestion(idx) {
    setSuggestions((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, checked: !s.checked } : s)),
    );
  }

  function editSuggestion(idx, text) {
    setSuggestions((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, text } : s)),
    );
  }

  function buildNotes() {
    const parts = [];
    const checked = suggestions.filter((s) => s.checked);
    if (checked.length > 0) {
      parts.push(checked.map((s) => `- ${s.text}`).join('\n'));
    }
    if (customNote.trim()) {
      parts.push(customNote.trim());
    }
    return parts.join('\n\n');
  }

  async function doReset(includeNotes = true) {
    setView('resetting');
    setError('');
    try {
      const notes = includeNotes ? buildNotes() : '';
      const body = notes ? { notes } : {};
      const res = await fetch(`/api/session/reset/${encodeURIComponent(groupFolder)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Reset failed');
      const next = { ...contextPressure.value };
      delete next[jid];
      contextPressure.value = next;
      onClose();
    } catch (err) {
      setError(err.message);
      setView('capture');
    }
  }

  function handleBackdropClick(e) {
    if (e.target === dialogRef.current) onClose();
  }

  const pressure = summary?.pressure;
  const messages = summary?.recentMessages || [];
  const claudeMd = summary?.claudeMd || '';

  // -- Summary view --
  function renderSummary() {
    if (loading) {
      return html`<div class="flex items-center justify-center py-12 text-txt-2 text-xs">Loading session data...</div>`;
    }
    if (!pressure || pressure.turnCount === 0) {
      return html`
        <div class="py-8 text-center text-txt-2 text-xs">
          <p>No session data found for this group.</p>
          <div class="flex justify-end gap-2 mt-6">
            <button class=${btnSecondary} onClick=${onClose}>Cancel</button>
            <button class=${btnDanger} onClick=${() => doReset(false)}>Reset Anyway</button>
          </div>
        </div>
      `;
    }
    return html`
      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-3">
          ${statCard('Turns', pressure.turnCount)}
          ${statCard('Total Cost', '$' + pressure.cumulativeCost?.toFixed(2))}
          ${statCard('Avg/Turn', '$' + pressure.avgCostPerTurn?.toFixed(2))}
          ${statCard('Cache/Turn', Math.round((pressure.avgCacheWriteTokens || 0) / 1000) + 'K tokens')}
        </div>

        ${messages.length > 0 && html`
          <div>
            <h4 class="text-xs font-medium text-txt-2 mb-2">Recent conversation</h4>
            <div class="max-h-48 overflow-y-auto rounded-lg border border-border bg-bg divide-y divide-border">
              ${messages.map((m) => html`
                <div class="px-3 py-2 text-xs">
                  <span class="font-medium ${m.is_bot_message ? 'text-accent' : 'text-txt'}">${m.sender_name}</span>
                  <span class="text-txt-2 ml-2">${m.content}</span>
                </div>
              `)}
            </div>
          </div>
        `}

        <div class="flex justify-end gap-2 pt-2">
          <button class=${btnSecondary} onClick=${onClose}>Cancel</button>
          <button class=${btnDanger} onClick=${() => doReset(false)}>Full Purge</button>
          <button class=${btnPrimary} onClick=${goToCapture}>Review & Save Notes</button>
        </div>
      </div>
    `;
  }

  // -- Capture view --
  function renderCapture() {
    const hasNotes = buildNotes().length > 0;
    const categoryLabels = { decision: 'Decision', preference: 'Preference', context: 'Context', learning: 'Learning' };
    const categoryColors = { decision: 'text-blue-400', preference: 'text-purple-400', context: 'text-green-400', learning: 'text-yellow-400' };

    return html`
      <div class="space-y-4">
        <p class="text-xs text-txt-2">
          The agent reflected on this session. Check the items worth keeping — they'll be saved to CLAUDE.md before the reset.
        </p>

        ${reflecting && html`
          <div class="flex items-center gap-2 py-4 text-xs text-txt-2">
            <div class="w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full animate-spin"></div>
            Agent is reflecting on the session...
          </div>
        `}

        ${!reflecting && suggestions.length > 0 && html`
          <div class="space-y-1.5">
            ${suggestions.map((s, i) => html`
              <div class="flex items-start gap-2 rounded-lg border border-border bg-bg px-3 py-2 group">
                <input
                  type="checkbox"
                  checked=${s.checked}
                  onChange=${() => toggleSuggestion(i)}
                  class="mt-0.5 shrink-0 accent-accent"
                />
                <div class="flex-1 min-w-0">
                  <input
                    type="text"
                    value=${s.text}
                    onInput=${(e) => editSuggestion(i, e.target.value)}
                    class="w-full text-xs bg-transparent text-txt border-none outline-none focus:bg-bg-2 rounded px-1 -mx-1 transition-colors"
                  />
                  <span class="text-[10px] ${categoryColors[s.category] || 'text-txt-muted'}">${categoryLabels[s.category] || s.category}</span>
                </div>
              </div>
            `)}
          </div>
        `}

        ${!reflecting && reflectDone && suggestions.length === 0 && html`
          <p class="text-xs text-txt-muted py-2">No suggestions generated. Add your own notes below.</p>
        `}

        <div>
          <textarea
            class="w-full h-20 px-3 py-2 text-xs bg-bg border border-border rounded-lg text-txt placeholder-txt-muted focus:outline-none focus:border-accent resize-none"
            placeholder="Add custom notes..."
            value=${customNote}
            onInput=${(e) => setCustomNote(e.target.value)}
          />
        </div>

        ${claudeMd && html`
          <div>
            <button
              class="text-xs text-txt-2 hover:text-txt transition-colors flex items-center gap-1"
              onClick=${() => setClaudeMdOpen(!claudeMdOpen)}
            >
              <span class="text-[10px]">${claudeMdOpen ? '\u25BC' : '\u25B6'}</span>
              Current CLAUDE.md
            </button>
            ${claudeMdOpen && html`
              <pre class="mt-2 max-h-40 overflow-y-auto rounded-lg border border-border bg-bg px-3 py-2 text-xs text-txt-2 whitespace-pre-wrap">${claudeMd}</pre>
            `}
          </div>
        `}

        ${error && html`<p class="text-xs text-red-400">${error}</p>`}

        <div class="flex justify-end gap-2 pt-2">
          <button class=${btnSecondary} onClick=${() => setView('summary')}>Back</button>
          <button class=${btnDanger} onClick=${() => doReset(false)}>Purge Without Notes</button>
          ${hasNotes && html`
            <button class=${btnPrimary} onClick=${() => doReset(true)}>Save & Reset</button>
          `}
          ${!hasNotes && !reflecting && html`
            <button class=${btnDanger} onClick=${() => doReset(false)}>Reset</button>
          `}
        </div>
      </div>
    `;
  }

  // -- Resetting view --
  function renderResetting() {
    return html`
      <div class="flex flex-col items-center justify-center py-12 gap-3">
        <div class="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin"></div>
        <p class="text-xs text-txt-2">Resetting session...</p>
      </div>
    `;
  }

  const titles = { summary: 'Session Retrospective', capture: 'Save Notes', resetting: 'Resetting' };

  return html`
    <dialog
      ref=${dialogRef}
      class="bg-transparent p-0 m-0 max-w-none w-screen h-screen backdrop:bg-black/60"
      onClick=${handleBackdropClick}
    >
      <div class="flex items-center justify-center w-full h-full p-4">
        <div class="bg-bg-2 border border-border rounded-xl w-full max-w-lg shadow-xl">
          <div class="flex items-center justify-between px-5 py-4 border-b border-border">
            <h3 class="text-sm font-semibold text-txt">${titles[view]}</h3>
            <button
              class="text-txt-2 hover:text-txt transition-colors text-lg leading-none"
              onClick=${onClose}
            >\u00D7</button>
          </div>
          <div class="px-5 py-4">
            ${view === 'summary' && renderSummary()}
            ${view === 'capture' && renderCapture()}
            ${view === 'resetting' && renderResetting()}
          </div>
        </div>
      </div>
    </dialog>
  `;
}

// -- Helpers --

function statCard(label, value) {
  return html`
    <div class="rounded-lg border border-border bg-bg px-3 py-2">
      <div class="text-[10px] text-txt-muted uppercase tracking-wide">${label}</div>
      <div class="text-sm font-semibold text-txt mt-0.5">${value}</div>
    </div>
  `;
}

const btnPrimary = 'px-3 py-1.5 text-xs font-semibold text-white bg-accent rounded-lg hover:opacity-90 transition-colors';
const btnSecondary = 'px-3 py-1.5 text-xs text-txt-2 hover:text-txt rounded-lg hover:bg-bg-hover transition-colors';
const btnDanger = 'px-3 py-1.5 text-xs font-semibold text-white bg-red-500 rounded-lg hover:bg-red-600 transition-colors';
