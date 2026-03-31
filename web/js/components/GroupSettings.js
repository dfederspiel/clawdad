import { html } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import { TONES, TONE_NAMES, getGroupTone, setGroupTone, previewTone, isMuted, setMuted } from '../sounds.js';
import * as api from '../api.js';
import { loadGroups, usage } from '../app.js';

export function GroupSettings({ group, open, onClose }) {
  const [subtitle, setSubtitle] = useState(group?.subtitle || '');
  const [tone, setTone] = useState('chime');
  const [muted, setMutedState] = useState(false);
  const [saving, setSaving] = useState(false);
  const [claudeMd, setClaudeMd] = useState(null);
  const [memoryFiles, setMemoryFiles] = useState(null);

  useEffect(() => {
    if (!group || !open) return;
    setSubtitle(group.subtitle || '');
    setTone(getGroupTone(group.jid));
    setMutedState(isMuted());
    setClaudeMd(null);
    setMemoryFiles(null);
  }, [group?.jid, open]);

  if (!open || !group) return null;

  const folderName = group.folder.replace(/^web_/, '');

  async function handleSaveSubtitle() {
    setSaving(true);
    try {
      await api.updateGroup(folderName, { subtitle });
      await loadGroups();
    } catch (err) {
      console.error('Failed to save subtitle:', err);
    } finally {
      setSaving(false);
    }
  }

  function handleToneChange(e) {
    const newTone = e.target.value;
    setTone(newTone);
    setGroupTone(group.jid, newTone);
    previewTone(newTone);
  }

  function handleMuteToggle() {
    const next = !muted;
    setMutedState(next);
    setMuted(next);
  }

  async function handleLoadClaudeMd() {
    try {
      const data = await api.getTranscript(group.folder);
      // Use transcript API as a proxy — but we actually want CLAUDE.md
      // For now, show a placeholder. Real implementation would need a file read API.
      setClaudeMd('(CLAUDE.md viewing coming soon — check groups/' + group.folder + '/CLAUDE.md)');
    } catch {
      setClaudeMd('(No CLAUDE.md found)');
    }
  }

  // Group usage from the usage signal
  const usg = usage.value;
  const groupUsage = usg?.byGroup?.find(g => g.group_folder === group.folder);

  return html`
    <div class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick=${onClose}>
      <div
        class="bg-bg-2 border border-border rounded-xl w-full max-w-md mx-4 max-h-[80vh] overflow-y-auto"
        onClick=${(e) => e.stopPropagation()}
      >
        <div class="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 class="text-sm font-semibold">${group.name}</h2>
          <button class="text-txt-muted hover:text-txt text-lg" onClick=${onClose}>\u00D7</button>
        </div>

        <div class="px-5 py-4 flex flex-col gap-5">
          <!-- Subtitle -->
          <div>
            <label class="text-[10px] text-txt-muted uppercase tracking-wider block mb-1.5">Status / Subtitle</label>
            <div class="flex gap-2">
              <input
                type="text"
                class="flex-1 bg-bg border border-border rounded-lg px-3 py-1.5 text-sm text-txt placeholder-txt-muted focus:outline-none focus:border-accent"
                placeholder="e.g. Monitoring PRs for review"
                value=${subtitle}
                onInput=${(e) => setSubtitle(e.target.value)}
                onKeyDown=${(e) => e.key === 'Enter' && handleSaveSubtitle()}
              />
              <button
                class="px-3 py-1.5 text-xs bg-accent text-bg rounded-lg hover:opacity-90 disabled:opacity-50"
                onClick=${handleSaveSubtitle}
                disabled=${saving}
              >${saving ? '...' : 'Save'}</button>
            </div>
          </div>

          <!-- Notification tone -->
          <div>
            <label class="text-[10px] text-txt-muted uppercase tracking-wider block mb-1.5">Notification Sound</label>
            <div class="flex items-center gap-3">
              <select
                class="flex-1 bg-bg border border-border rounded-lg px-3 py-1.5 text-sm text-txt focus:outline-none focus:border-accent"
                value=${tone}
                onChange=${handleToneChange}
              >
                ${TONE_NAMES.map(t => html`
                  <option value=${t}>${TONES[t].name}</option>
                `)}
              </select>
              <label class="flex items-center gap-1.5 text-xs text-txt-2 cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked=${muted}
                  onChange=${handleMuteToggle}
                  class="rounded"
                />
                Mute all
              </label>
            </div>
          </div>

          <!-- Group info -->
          <div>
            <label class="text-[10px] text-txt-muted uppercase tracking-wider block mb-1.5">Group Info</label>
            <div class="grid grid-cols-2 gap-2 text-xs">
              <div class="text-txt-muted">Folder</div>
              <div class="text-txt font-mono">${group.folder}</div>
              <div class="text-txt-muted">JID</div>
              <div class="text-txt font-mono">${group.jid}</div>
              ${group.isMain && html`
                <div class="text-txt-muted">Role</div>
                <div class="text-accent font-medium">Main</div>
              `}
            </div>
          </div>

          <!-- Usage stats -->
          ${groupUsage && html`
            <div>
              <label class="text-[10px] text-txt-muted uppercase tracking-wider block mb-1.5">Usage (24h)</label>
              <div class="grid grid-cols-3 gap-2 text-xs">
                <div class="flex flex-col">
                  <span class="text-txt-muted">Runs</span>
                  <span class="text-txt font-mono">${groupUsage.runs}</span>
                </div>
                <div class="flex flex-col">
                  <span class="text-txt-muted">Tokens</span>
                  <span class="text-txt font-mono">${((groupUsage.input_tokens + groupUsage.output_tokens) / 1000).toFixed(1)}k</span>
                </div>
                <div class="flex flex-col">
                  <span class="text-txt-muted">Cost</span>
                  <span class="text-txt font-mono">$${groupUsage.cost_usd < 0.01 ? groupUsage.cost_usd.toFixed(4) : groupUsage.cost_usd.toFixed(2)}</span>
                </div>
              </div>
            </div>
          `}
        </div>
      </div>
    </div>
  `;
}
