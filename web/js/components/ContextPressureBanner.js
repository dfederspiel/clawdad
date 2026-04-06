import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { currentContextPressure, dismissedPressure, selectedJid, contextPressure, groups } from '../app.js';
import * as api from '../api.js';

export function ContextPressureBanner() {
  const pressure = currentContextPressure.value;
  const jid = selectedJid.value;
  const [resetting, setResetting] = useState(false);

  if (!pressure || !jid) return null;
  if (dismissedPressure.value[jid]) return null;

  const costPerTurn = pressure.avgCostPerTurn?.toFixed(2);
  const totalCost = pressure.cumulativeCost?.toFixed(2);
  const turns = pressure.turnCount;
  const cacheWriteK = Math.round((pressure.avgCacheWriteTokens || 0) / 1000);

  const dismiss = () => {
    dismissedPressure.value = { ...dismissedPressure.value, [jid]: true };
  };

  const resetSession = async () => {
    const groupFolder = pressure.groupFolder;
    if (!groupFolder) return;
    if (!confirm(`Reset session for this group? The agent will lose its conversation history and start fresh. This cannot be undone.`)) return;

    setResetting(true);
    try {
      await fetch(`/api/session/reset/${encodeURIComponent(groupFolder)}`, { method: 'POST' });
      // Clear the pressure signal locally
      const next = { ...contextPressure.value };
      delete next[jid];
      contextPressure.value = next;
    } catch (err) {
      console.error('Session reset failed:', err);
    } finally {
      setResetting(false);
    }
  };

  return html`
    <div class="flex items-center gap-3 px-4 py-2 text-xs bg-yellow-900/20 border-b border-yellow-700/30 text-yellow-200">
      <span class="shrink-0 text-yellow-400">\u26A0</span>
      <span class="flex-1">
        <span class="font-medium">Session context growing</span>
        ${' \u2014 '}$${costPerTurn}/turn avg across ${turns} turns ($${totalCost} total).
        ${cacheWriteK > 0 && html` ${cacheWriteK}K tokens cached per turn.`}
      </span>
      <button
        onClick=${resetSession}
        disabled=${resetting}
        class="shrink-0 px-2 py-0.5 rounded text-xs font-medium bg-yellow-700/40 hover:bg-yellow-700/60 text-yellow-200 transition-colors disabled:opacity-50"
        title="Clear session history and start fresh. Reduces cost per turn."
      >${resetting ? 'Resetting...' : 'Reset Session'}</button>
      <button
        onClick=${dismiss}
        class="shrink-0 text-yellow-400/60 hover:text-yellow-200 transition-colors"
        title="Dismiss"
      >\u2715</button>
    </div>
  `;
}
