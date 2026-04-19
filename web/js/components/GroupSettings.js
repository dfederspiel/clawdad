import { html } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import { TONES, TONE_NAMES, getGroupTone, setGroupTone, previewTone, isMuted, setMuted } from '../sounds.js';
import * as api from '../api.js';
import { groups, loadGroups, usage, deleteGroup } from '../app.js';
import { ConfirmDialog } from './ConfirmDialog.js';

export function GroupSettings({ group, open, onClose }) {
  const [subtitle, setSubtitle] = useState(group?.subtitle || '');
  const [tone, setTone] = useState('chime');
  const [muted, setMutedState] = useState(false);
  const [saving, setSaving] = useState(false);
  const [claudeMd, setClaudeMd] = useState(null);
  const [memoryFiles, setMemoryFiles] = useState(null);
  const [agentName, setAgentName] = useState('');
  const [agentDisplayName, setAgentDisplayName] = useState('');
  const [agentTrigger, setAgentTrigger] = useState('');
  const [agentInstructions, setAgentInstructions] = useState('');
  const [selectedSource, setSelectedSource] = useState('');
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentError, setAgentError] = useState('');
  const [agentDisplayNames, setAgentDisplayNames] = useState({});
  const [agentProvider, setAgentProvider] = useState('anthropic');
  const [agentModel, setAgentModel] = useState('');
  const [ollamaModels, setOllamaModels] = useState([]);
  const [agentRuntimeEdits, setAgentRuntimeEdits] = useState({}); // { [agentName]: { provider, model } }
  const [toolRegistry, setToolRegistry] = useState([]);
  // { [agentName]: { override: boolean, selected: string[] } }
  //   override=false → use role default (no agent.tools persisted)
  //   override=true + selected=[] → explicit "no tools" opt-out
  const [agentToolEdits, setAgentToolEdits] = useState({});
  const [toolsExpanded, setToolsExpanded] = useState({});
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!group || !open) return;
    setSubtitle(group.subtitle || '');
    setTone(getGroupTone(group.jid));
    setMutedState(isMuted());
    setClaudeMd(null);
    setMemoryFiles(null);
    setAgentName('');
    setAgentDisplayName('');
    setAgentTrigger('');
    setAgentInstructions('');
    setSelectedSource('');
    setAgentBusy(false);
    setAgentError('');
    setAgentDisplayNames(
      Object.fromEntries((group.agents || []).map((agent) => [
        agent.name,
        agent.displayName || agent.name,
      ])),
    );
    setAgentRuntimeEdits({});
    setAgentProvider('anthropic');
    setAgentModel('');
    setAgentToolEdits({});
    setToolsExpanded({});
    // Fetch Ollama models (best-effort)
    api.getOllamaModels().then((data) => {
      setOllamaModels(data.models || []);
    }).catch(() => {});
    // Fetch available tools catalogue (best-effort)
    api.getTools().then((data) => {
      setToolRegistry(data.tools || []);
    }).catch(() => setToolRegistry([]));
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

  function resetAgentForm() {
    setAgentName('');
    setAgentDisplayName('');
    setAgentTrigger('');
    setAgentInstructions('');
    setSelectedSource('');
    setAgentProvider('anthropic');
    setAgentModel('');
    setAgentError('');
  }

  async function handleAddAgent(e) {
    e.preventDefault();
    if (!agentName.trim() || agentBusy) return;
    setAgentBusy(true);
    setAgentError('');
    try {
      const payload = {
        name: agentName.trim(),
        displayName: agentDisplayName.trim(),
        trigger: agentTrigger.trim(),
        instructions: agentInstructions.trim(),
      };
      if (agentProvider !== 'anthropic' || agentModel.trim()) {
        payload.runtime = {
          provider: agentProvider,
          ...(agentModel.trim() ? { model: agentModel.trim() } : {}),
        };
      }
      await api.addGroupAgent(folderName, payload);
      await loadGroups();
      resetAgentForm();
    } catch (err) {
      setAgentError(err.message || 'Failed to add agent');
    } finally {
      setAgentBusy(false);
    }
  }

  async function handleCloneAgent(e) {
    e.preventDefault();
    if (!selectedSource || !agentName.trim() || agentBusy) return;
    setAgentBusy(true);
    setAgentError('');
    try {
      const [sourceGroupJid, sourceAgentName] = selectedSource.split('::');
      await api.addGroupAgent(folderName, {
        name: agentName.trim(),
        displayName: agentDisplayName.trim(),
        trigger: agentTrigger.trim(),
        sourceGroupJid,
        sourceAgentName,
      });
      await loadGroups();
      resetAgentForm();
    } catch (err) {
      setAgentError(err.message || 'Failed to clone agent');
    } finally {
      setAgentBusy(false);
    }
  }

  async function handleRemoveAgent(name) {
    if (agentBusy) return;
    setAgentBusy(true);
    setAgentError('');
    try {
      await api.deleteGroupAgent(folderName, name);
      await loadGroups();
    } catch (err) {
      setAgentError(err.message || 'Failed to remove agent');
    } finally {
      setAgentBusy(false);
    }
  }

  async function handleSaveAgentDisplayName(name) {
    if (agentBusy) return;
    setAgentBusy(true);
    setAgentError('');
    try {
      await api.updateGroupAgent(folderName, name, {
        displayName: agentDisplayNames[name] || name,
      });
      await loadGroups();
    } catch (err) {
      setAgentError(err.message || 'Failed to update agent display name');
    } finally {
      setAgentBusy(false);
    }
  }

  function getAgentToolsEdit(name) {
    if (agentToolEdits[name]) return agentToolEdits[name];
    const agent = (group.agents || []).find((a) => a.name === name);
    const persisted = agent?.tools;
    return {
      override: Array.isArray(persisted),
      selected: Array.isArray(persisted) ? [...persisted] : [],
    };
  }

  function setAgentToolsEdit(name, next) {
    setAgentToolEdits((prev) => ({ ...prev, [name]: next }));
  }

  function agentToolsDirty(name) {
    const edit = agentToolEdits[name];
    if (!edit) return false;
    const agent = (group.agents || []).find((a) => a.name === name);
    const persistedOverride = Array.isArray(agent?.tools);
    if (edit.override !== persistedOverride) return true;
    if (!edit.override) return false;
    const persistedSelected = agent?.tools ?? [];
    if (edit.selected.length !== persistedSelected.length) return true;
    const persistedSet = new Set(persistedSelected);
    return edit.selected.some((t) => !persistedSet.has(t));
  }

  async function handleSaveAgentTools(name) {
    if (agentBusy) return;
    const edit = getAgentToolsEdit(name);
    setAgentBusy(true);
    setAgentError('');
    try {
      await api.updateGroupAgent(folderName, name, {
        tools: edit.override ? edit.selected : null,
      });
      await loadGroups();
      setAgentToolEdits((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    } catch (err) {
      setAgentError(err.message || 'Failed to update agent tools');
    } finally {
      setAgentBusy(false);
    }
  }

  async function handleSaveAgentRuntime(name) {
    if (agentBusy) return;
    const edit = agentRuntimeEdits[name];
    if (!edit) return;
    setAgentBusy(true);
    setAgentError('');
    try {
      const runtime =
        edit.provider === 'anthropic' && !edit.model
          ? null // reset to default
          : { provider: edit.provider, model: edit.model || undefined };
      await api.updateGroupAgent(folderName, name, { runtime });
      await loadGroups();
      // Don't clear agentRuntimeEdits — the edit state keeps the UI
      // showing the saved value until the group prop re-renders with
      // the updated agent data. The Save button hides automatically
      // when the edit matches the persisted value.
    } catch (err) {
      setAgentError(err.message || 'Failed to update agent runtime');
    } finally {
      setAgentBusy(false);
    }
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
  const availableSources = groups.value
    .filter((g) => g.jid !== group.jid)
    .flatMap((g) => (g.agents || []).map((agent) => ({
      key: `${g.jid}::${agent.name}`,
      label: `${g.name} / ${agent.displayName || agent.name}`,
      trigger: agent.trigger || '',
    })));

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

          <div>
            <label class="text-[10px] text-txt-muted uppercase tracking-wider block mb-2">Agents</label>
            <div class="flex flex-col gap-3">
              ${(group.agents || []).map((agent) => html`
                <div class="border border-border rounded-lg px-3 py-2 flex items-start justify-between gap-3">
                  <div class="min-w-0 flex-1">
                    <div class="flex gap-2 items-center">
                      <input
                        type="text"
                        class="flex-1 bg-bg border border-border rounded-lg px-2 py-1 text-sm text-txt focus:outline-none focus:border-accent"
                        value=${agentDisplayNames[agent.name] ?? agent.displayName ?? agent.name}
                        onInput=${(e) => setAgentDisplayNames((prev) => ({
                          ...prev,
                          [agent.name]: e.target.value,
                        }))}
                      />
                      <button
                        class="px-2 py-1 text-xs bg-bg-3 border border-border rounded-md text-txt-2 hover:border-accent disabled:opacity-50"
                        onClick=${() => handleSaveAgentDisplayName(agent.name)}
                        disabled=${agentBusy || (agentDisplayNames[agent.name] ?? agent.displayName ?? agent.name) === (agent.displayName || agent.name)}
                      >Save</button>
                    </div>
                    <div class="text-xs text-txt-muted font-mono mt-1">${agent.name}${agent.trigger ? ` · ${agent.trigger}` : ' · coordinator'}</div>
                    <div class="flex gap-2 items-center mt-1.5">
                      <select
                        class="bg-bg border border-border rounded px-1.5 py-0.5 text-xs text-txt focus:outline-none focus:border-accent"
                        value=${agentRuntimeEdits[agent.name]?.provider ?? agent.runtime?.provider ?? 'anthropic'}
                        onChange=${(e) => setAgentRuntimeEdits((prev) => ({
                          ...prev,
                          [agent.name]: {
                            provider: e.target.value,
                            model: e.target.value === (agent.runtime?.provider || 'anthropic')
                              ? (prev[agent.name]?.model ?? agent.runtime?.model ?? '')
                              : '',
                          },
                        }))}
                      >
                        <option value="anthropic">Anthropic</option>
                        <option value="ollama">Ollama</option>
                      </select>
                      ${(() => {
                        const prov = agentRuntimeEdits[agent.name]?.provider ?? agent.runtime?.provider ?? 'anthropic';
                        const modelVal = agentRuntimeEdits[agent.name]?.model ?? agent.runtime?.model ?? '';
                        if (prov === 'ollama' && ollamaModels.length > 0) {
                          return html`<select
                            class="bg-bg border border-border rounded px-1.5 py-0.5 text-xs text-txt focus:outline-none focus:border-accent"
                            value=${modelVal}
                            onChange=${(e) => setAgentRuntimeEdits((prev) => ({
                              ...prev,
                              [agent.name]: { ...prev[agent.name], provider: prov, model: e.target.value },
                            }))}
                          >
                            <option value="">Select model...</option>
                            ${ollamaModels.map((m) => html`<option value=${m.name}>${m.name}</option>`)}
                          </select>`;
                        }
                        return html`<input
                          type="text"
                          class="bg-bg border border-border rounded px-1.5 py-0.5 text-xs text-txt placeholder-txt-muted focus:outline-none focus:border-accent w-32"
                          placeholder=${prov === 'ollama' ? 'Model name' : 'Default model'}
                          value=${modelVal}
                          onInput=${(e) => setAgentRuntimeEdits((prev) => ({
                            ...prev,
                            [agent.name]: { ...prev[agent.name], provider: prov, model: e.target.value },
                          }))}
                        />`;
                      })()}
                      ${agentRuntimeEdits[agent.name] && (
                        agentRuntimeEdits[agent.name].provider !== (agent.runtime?.provider || 'anthropic') ||
                        agentRuntimeEdits[agent.name].model !== (agent.runtime?.model || '')
                      ) && html`<button
                        class="px-1.5 py-0.5 text-xs bg-bg-3 border border-border rounded text-txt-2 hover:border-accent disabled:opacity-50"
                        onClick=${() => handleSaveAgentRuntime(agent.name)}
                        disabled=${agentBusy}
                      >Save</button>`}
                    </div>
                    ${(() => {
                      if (agent.receivesMcpTools === false) {
                        return html`
                          <div class="mt-1.5 text-xs text-txt-muted">
                            Tools: <span class="italic">unavailable — this runtime does not support tool calling</span>
                          </div>
                        `;
                      }
                      const edit = getAgentToolsEdit(agent.name);
                      const expanded = !!toolsExpanded[agent.name];
                      const dirty = agentToolsDirty(agent.name);
                      const bySource = toolRegistry.reduce((acc, t) => {
                        (acc[t.source] = acc[t.source] || []).push(t);
                        return acc;
                      }, {});
                      const summary = !edit.override
                        ? `Tools: role default`
                        : edit.selected.length === 0
                          ? `Tools: none (explicit)`
                          : `Tools: ${edit.selected.length} selected`;
                      return html`
                        <div class="mt-1.5">
                          <button
                            class="text-xs text-txt-muted hover:text-txt flex items-center gap-1"
                            onClick=${() => setToolsExpanded((prev) => ({ ...prev, [agent.name]: !prev[agent.name] }))}
                          >
                            <span>${expanded ? '\u25BC' : '\u25B6'}</span>
                            <span>${summary}</span>
                            ${dirty && html`<span class="text-accent">\u2022 unsaved</span>`}
                          </button>
                          ${expanded && html`
                            <div class="mt-2 border border-border rounded-lg p-2 flex flex-col gap-2">
                              <label class="flex items-center gap-2 text-xs text-txt-2">
                                <input
                                  type="checkbox"
                                  checked=${edit.override}
                                  onChange=${(e) => setAgentToolsEdit(agent.name, {
                                    override: e.target.checked,
                                    selected: e.target.checked
                                      ? (edit.selected.length > 0 ? edit.selected : toolRegistry.filter((t) => t.defaultForRole === (agent.trigger ? 'specialist' : 'coordinator')).map((t) => t.name))
                                      : [],
                                  })}
                                />
                                <span>Override role default</span>
                              </label>
                              ${edit.override && Object.entries(bySource).map(([source, list]) => html`
                                <div>
                                  <div class="text-[10px] text-txt-muted uppercase tracking-wider mb-1">${source === 'claude-sdk' ? 'Claude SDK' : 'Nanoclaw MCP'}</div>
                                  <div class="grid grid-cols-2 gap-x-3 gap-y-1">
                                    ${list.map((tool) => html`
                                      <label class="flex items-center gap-1.5 text-xs text-txt-2" title=${tool.description}>
                                        <input
                                          type="checkbox"
                                          checked=${edit.selected.includes(tool.name)}
                                          onChange=${(e) => {
                                            const selected = e.target.checked
                                              ? [...edit.selected, tool.name]
                                              : edit.selected.filter((n) => n !== tool.name);
                                            setAgentToolsEdit(agent.name, { override: true, selected });
                                          }}
                                        />
                                        <span class="truncate">${tool.label}</span>
                                      </label>
                                    `)}
                                  </div>
                                </div>
                              `)}
                              <button
                                class="px-2 py-1 text-xs bg-bg-3 border border-border rounded text-txt-2 hover:border-accent disabled:opacity-50 self-start"
                                onClick=${() => handleSaveAgentTools(agent.name)}
                                disabled=${agentBusy || !dirty}
                              >Save tools</button>
                            </div>
                          `}
                        </div>
                      `;
                    })()}
                  </div>
                  <button
                    class="px-2 py-1 text-xs border border-border rounded-md text-txt-2 hover:border-red-400 hover:text-red-300 disabled:opacity-50"
                    onClick=${() => handleRemoveAgent(agent.name)}
                    disabled=${agentBusy || (group.agents || []).length <= 1}
                  >Remove</button>
                </div>
              `)}
            </div>
          </div>

          <form class="flex flex-col gap-2" onSubmit=${handleAddAgent}>
            <label class="text-[10px] text-txt-muted uppercase tracking-wider block">Add New Agent</label>
            <input
              type="text"
              class="bg-bg border border-border rounded-lg px-3 py-1.5 text-sm text-txt placeholder-txt-muted focus:outline-none focus:border-accent"
              placeholder="Agent name"
              value=${agentName}
              onInput=${(e) => setAgentName(e.target.value)}
            />
            <input
              type="text"
              class="bg-bg border border-border rounded-lg px-3 py-1.5 text-sm text-txt placeholder-txt-muted focus:outline-none focus:border-accent"
              placeholder="Display name"
              value=${agentDisplayName}
              onInput=${(e) => setAgentDisplayName(e.target.value)}
            />
            <input
              type="text"
              class="bg-bg border border-border rounded-lg px-3 py-1.5 text-sm text-txt placeholder-txt-muted focus:outline-none focus:border-accent"
              placeholder="Trigger, e.g. @Researcher"
              value=${agentTrigger}
              onInput=${(e) => setAgentTrigger(e.target.value)}
            />
            <div class="flex gap-2">
              <select
                class="bg-bg border border-border rounded-lg px-3 py-1.5 text-sm text-txt focus:outline-none focus:border-accent"
                value=${agentProvider}
                onChange=${(e) => { setAgentProvider(e.target.value); setAgentModel(''); }}
              >
                <option value="anthropic">Anthropic</option>
                <option value="ollama">Ollama</option>
              </select>
              ${agentProvider === 'ollama' && ollamaModels.length > 0 ? html`
                <select
                  class="flex-1 bg-bg border border-border rounded-lg px-3 py-1.5 text-sm text-txt focus:outline-none focus:border-accent"
                  value=${agentModel}
                  onChange=${(e) => setAgentModel(e.target.value)}
                >
                  <option value="">Select model...</option>
                  ${ollamaModels.map((m) => html`<option value=${m.name}>${m.name}</option>`)}
                </select>
              ` : html`
                <input
                  type="text"
                  class="flex-1 bg-bg border border-border rounded-lg px-3 py-1.5 text-sm text-txt placeholder-txt-muted focus:outline-none focus:border-accent"
                  placeholder=${agentProvider === 'ollama' ? 'Model name (required)' : 'Model (optional)'}
                  value=${agentModel}
                  onInput=${(e) => setAgentModel(e.target.value)}
                />
              `}
            </div>
            <textarea
              class="bg-bg border border-border rounded-lg px-3 py-2 text-sm text-txt placeholder-txt-muted focus:outline-none focus:border-accent min-h-24"
              placeholder="Optional starter instructions"
              value=${agentInstructions}
              onInput=${(e) => setAgentInstructions(e.target.value)}
            />
            <button
              type="submit"
              class="px-3 py-1.5 text-xs bg-accent text-bg rounded-lg hover:opacity-90 disabled:opacity-50 self-start"
              disabled=${agentBusy || !agentName.trim() || (agentProvider === 'ollama' && !agentModel.trim())}
            >${agentBusy ? 'Working...' : 'Add Agent'}</button>
          </form>

          <form class="flex flex-col gap-2" onSubmit=${handleCloneAgent}>
            <label class="text-[10px] text-txt-muted uppercase tracking-wider block">Pull Existing Agent Into Group</label>
            <select
              class="bg-bg border border-border rounded-lg px-3 py-1.5 text-sm text-txt focus:outline-none focus:border-accent"
              value=${selectedSource}
              onChange=${(e) => setSelectedSource(e.target.value)}
            >
              <option value="">Choose an agent to copy</option>
              ${availableSources.map((source) => html`
                <option value=${source.key}>${source.label}${source.trigger ? ` (${source.trigger})` : ''}</option>
              `)}
            </select>
            <div class="text-xs text-txt-muted">This copies instructions/config into this group so it can evolve independently.</div>
            <button
              type="submit"
              class="px-3 py-1.5 text-xs bg-bg-3 border border-border text-txt rounded-lg hover:border-accent disabled:opacity-50 self-start"
              disabled=${agentBusy || !selectedSource || !agentName.trim()}
            >Clone Into Group</button>
          </form>

          ${agentError && html`
            <div class="text-xs text-red-300 border border-red-500/30 rounded-lg px-3 py-2 bg-red-500/5">${agentError}</div>
          `}

          ${!group.isSystem && !group.isMain && html`
            <div class="border-t border-red-500/20 pt-4 mt-2">
              <label class="text-[10px] text-red-300 uppercase tracking-wider block mb-1.5">Danger zone</label>
              <p class="text-xs text-txt-muted mb-2">
                Deletes this group and all of its messages, tasks, and agent data. This cannot be undone.
              </p>
              <button
                class="px-3 py-1.5 text-xs border border-red-500/40 text-red-300 rounded-lg hover:bg-red-500/10 disabled:opacity-50"
                onClick=${() => setDeleteOpen(true)}
                disabled=${deleting}
              >Delete group</button>
            </div>
          `}
        </div>
      </div>
      <${ConfirmDialog}
        open=${deleteOpen}
        title=${`Delete "${group.name}"?`}
        message="This removes all messages, tasks, and agent data for this group. This cannot be undone."
        confirmLabel="Delete"
        confirmText=${group.name}
        destructive=${true}
        loading=${deleting}
        onConfirm=${async () => {
          setDeleting(true);
          try {
            await deleteGroup(folderName, group.jid);
            setDeleteOpen(false);
            onClose();
          } catch (err) {
            console.error('Delete failed:', err);
          } finally {
            setDeleting(false);
          }
        }}
        onCancel=${() => setDeleteOpen(false)}
      />
    </div>
  `;
}
