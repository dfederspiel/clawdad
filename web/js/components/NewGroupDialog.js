import { html } from 'htm/preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { createGroup, createTeam } from '../app.js';
import * as api from '../api.js';

const DEFAULT_SPECIALIST = () => ({
  name: '',
  displayName: '',
  trigger: '',
  instructions: '',
  provider: 'anthropic',
  model: '',
});
const DEFAULT_COORDINATOR = () => ({
  displayName: 'Coordinator',
  instructions: '',
  provider: 'anthropic',
  model: '',
});

const TIER_META = {
  beginner: { label: 'Getting Started', desc: 'Learn the basics — each template guides you step by step' },
  advanced: { label: 'Advanced', desc: 'Power features — triggers, monitoring, and orchestration' },
  recipe: { label: 'Recipes', desc: 'Pre-built workflows for specific use cases' },
};

const TIER_ORDER = ['beginner', 'advanced', 'recipe'];

function TemplateCard({ template, onSelect, creating }) {
  const tierColors = {
    beginner: 'border-green-500/30 hover:border-green-500/60',
    advanced: 'border-purple-500/30 hover:border-purple-500/60',
    recipe: 'border-border hover:border-accent/50',
  };
  const tier = template.tier || 'recipe';

  return html`
    <button
      class="bg-bg-3 border rounded-xl p-4 flex flex-col gap-2 text-left transition-colors ${tierColors[tier] || tierColors.recipe} disabled:opacity-40"
      onClick=${() => onSelect(template)}
      disabled=${creating}
    >
      <h3 class="text-sm font-semibold text-txt">${template.name}</h3>
      <p class="text-xs text-txt-2 flex-1">${template.description}</p>
    </button>
  `;
}

export function NewGroupDialog({ open, onClose, initialView = 'pick' }) {
  const dialogRef = useRef(null);
  const [templates, setTemplates] = useState([]);
  const [view, setView] = useState('pick'); // 'pick' | 'name' | 'custom' | 'team'
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [agentType, setAgentType] = useState('standalone');
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [description, setDescription] = useState('');
  const [trigger, setTrigger] = useState('');
  const [manual, setManual] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Provider/model state
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('');
  const [ollamaModels, setOllamaModels] = useState([]);

  // Team creation state
  const [teamCoordinator, setTeamCoordinator] = useState(DEFAULT_COORDINATOR());
  const [teamSpecialists, setTeamSpecialists] = useState([DEFAULT_SPECIALIST()]);

  useEffect(() => {
    if (open) {
      if (dialogRef.current && !dialogRef.current.open) {
        dialogRef.current.showModal();
      }
      setView(initialView);
      setError('');
      api.getTemplates().then((data) => setTemplates(data.templates || [])).catch(() => {});
      api.getOllamaModels().then((data) => setOllamaModels(data.models || [])).catch(() => {});
    } else if (dialogRef.current?.open) {
      dialogRef.current.close();
    }
  }, [open]);

  function slugify(val) {
    return val.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'group';
  }

  async function handleTemplateSelect(template) {
    setSubmitting(true);
    setError('');
    try {
      const opts = {};
      if (template.triggerScope) {
        opts.triggerScope = template.triggerScope;
        opts.trigger = template.trigger || `@${template.name}`;
        opts.description = template.description || '';
      }
      const result = await createGroup(template.name, template.id, template.id, opts);
      await api.sendMessage(result.jid, 'Hello! Help me get set up.');
      resetForm();
      onClose();
    } catch (err) {
      // If group already exists, let the user pick a custom name
      if (err.message && err.message.includes('already exists')) {
        setSelectedTemplate(template);
        setName(template.name + ' 2');
        setFolder(slugify(template.name + ' 2'));
        setManual(false);
        setError('');
        setView('name');
      } else {
        setError(err.message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleNamedTemplateCreate(e) {
    e.preventDefault();
    if (!name.trim() || !folder.trim() || !selectedTemplate || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await createGroup(name.trim(), folder.trim(), selectedTemplate.id);
      await api.sendMessage(result.jid, 'Hello! Help me get set up.');
      resetForm();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  function onNameInput(e) {
    const val = e.target.value;
    setName(val);
    if (!manual) setFolder(slugify(val));
    if (agentType === 'triggered') setTrigger(`@${val}`);
  }

  function onFolderInput(e) {
    setManual(true);
    setFolder(e.target.value);
  }

  function switchAgentType(type) {
    setAgentType(type);
    if (type === 'triggered') {
      setTrigger(name ? `@${name}` : '');
    } else {
      setTrigger('');
    }
    setError('');
  }

  function resetForm() {
    setName('');
    setFolder('');
    setDescription('');
    setTrigger('');
    setSelectedTemplate(null);
    setAgentType('standalone');
    setManual(false);
    setView('pick');
    setProvider('anthropic');
    setModel('');
    setTeamCoordinator(DEFAULT_COORDINATOR());
    setTeamSpecialists([DEFAULT_SPECIALIST()]);
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (!name.trim() || !folder.trim() || submitting) return;
    if (agentType === 'triggered' && !description.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      const opts = agentType === 'triggered'
        ? {
            triggerScope: 'web-all',
            trigger: trigger.trim() || `@${name.trim()}`,
            description: description.trim(),
          }
        : {};

      const result = await createGroup(name.trim(), folder.trim(), undefined, opts);

      // Create explicit default agent with runtime if non-default provider/model selected
      if (provider !== 'anthropic' || model.trim()) {
        const folderSlug = folder.trim();
        await api.addGroupAgent(folderSlug, {
          name: 'default',
          displayName: name.trim(),
          runtime: { provider, ...(model.trim() ? { model: model.trim() } : {}) },
        }).catch(() => {});
      }

      if (agentType === 'standalone' && description.trim()) {
        await api.sendMessage(result.jid, description.trim());
      }

      resetForm();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  function updateSpecialist(index, field, value) {
    setTeamSpecialists((prev) => {
      const next = [...prev];
      const previousName = next[index].name;
      next[index] = { ...next[index], [field]: value };
      if (field === 'name') {
        next[index].trigger = `@${value}`;
        if (
          !next[index].displayName ||
          next[index].displayName === previousName
        ) {
          next[index].displayName = value;
        }
      }
      return next;
    });
  }

  // Build a runtime config payload only when the user picked something
  // non-default. Anthropic with no model is the platform default, so we
  // omit it to keep agent.json clean.
  function buildRuntime(provider, model) {
    if (provider === 'anthropic' && !model) return undefined;
    const out = { provider };
    if (model) out.model = model;
    return out;
  }

  function addSpecialist() {
    setTeamSpecialists((prev) => [...prev, DEFAULT_SPECIALIST()]);
  }

  function removeSpecialist(index) {
    setTeamSpecialists((prev) => prev.filter((_, i) => i !== index));
  }

  async function onTeamSubmit(e) {
    e.preventDefault();
    if (!name.trim() || !folder.trim() || submitting) return;
    const validSpecs = teamSpecialists.filter((s) => s.name.trim() && s.trigger.trim());
    if (validSpecs.length === 0) return;
    setSubmitting(true);
    setError('');
    try {
      await createTeam({
        name: name.trim(),
        folder: folder.trim(),
        coordinator: {
          displayName: teamCoordinator.displayName,
          instructions: teamCoordinator.instructions,
          runtime: buildRuntime(teamCoordinator.provider, teamCoordinator.model),
        },
        specialists: validSpecs.map((s) => ({
          name: s.name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
          displayName: s.displayName.trim() || s.name.trim(),
          trigger: s.trigger.trim(),
          instructions: s.instructions.trim(),
          runtime: buildRuntime(s.provider, s.model),
        })),
      });
      resetForm();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  function renderProviderModelRow(prov, setProv, mod, setMod, labelPrefix = '') {
    return html`
      <div class="flex flex-col gap-1.5">
        <span class="text-sm text-txt-2">${labelPrefix ? `${labelPrefix} ` : ''}Provider / Model</span>
        <div class="flex gap-2">
          <select
            class="bg-bg-3 border border-border rounded-lg px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent"
            value=${prov}
            onChange=${(e) => { setProv(e.target.value); setMod(''); }}
          >
            <option value="anthropic">Anthropic</option>
            <option value="ollama">Ollama</option>
          </select>
          ${prov === 'ollama' && ollamaModels.length > 0 ? html`
            <select
              class="flex-1 bg-bg-3 border border-border rounded-lg px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent"
              value=${mod}
              onChange=${(e) => setMod(e.target.value)}
            >
              <option value="">Select model...</option>
              ${ollamaModels.map((m) => html`<option value=${m.name}>${m.name}</option>`)}
            </select>
          ` : html`
            <input
              type="text"
              class="flex-1 bg-bg-3 border border-border rounded-lg px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent"
              placeholder=${prov === 'ollama' ? 'Model name (required)' : 'Model (optional, uses default)'}
              value=${mod}
              onInput=${(e) => setMod(e.target.value)}
            />
          `}
        </div>
      </div>
    `;
  }

  const isTriggered = agentType === 'triggered';
  const pillClass = (active) => active
    ? 'bg-accent text-bg border-accent font-semibold'
    : 'bg-bg-3 text-txt-2 border-border hover:border-accent/50';

  return html`
    <dialog
      ref=${dialogRef}
      class="bg-bg-2 text-txt border border-border rounded-xl p-0 backdrop:bg-black/60 ${view === 'pick' || view === 'team' ? 'max-w-2xl' : 'max-w-md'} w-full max-h-[85vh] flex flex-col overflow-hidden"
      style=${{ display: open ? undefined : 'none' }}
      onClose=${() => { resetForm(); onClose(); }}
      onClick=${(e) => { if (e.target === dialogRef.current) { resetForm(); onClose(); } }}
    >
      ${view === 'pick' ? html`
        <div class="flex flex-col min-h-0">
          <div class="flex items-center justify-between px-6 pt-6 pb-4">
            <h2 class="text-lg font-semibold">New Agent</h2>
            <button
              class="text-txt-muted hover:text-txt transition-colors text-lg leading-none px-1"
              onClick=${() => { resetForm(); onClose(); }}
            >x</button>
          </div>

          <div class="flex-1 overflow-y-auto px-6 pb-2 flex flex-col gap-5">
          ${templates.length > 0 ? html`
            ${TIER_ORDER.filter((tier) => templates.some((t) => (t.tier || 'recipe') === tier)).map((tier) => {
              const tierTemplates = templates.filter((t) => (t.tier || 'recipe') === tier);
              const meta = TIER_META[tier] || TIER_META.recipe;
              return html`
                <div key=${tier}>
                  <div class="mb-2">
                    <h3 class="text-sm font-semibold text-txt">${meta.label}</h3>
                    <p class="text-xs text-txt-muted">${meta.desc}</p>
                  </div>
                  <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    ${tierTemplates.map((t) => html`
                      <${TemplateCard}
                        key=${t.id}
                        template=${t}
                        onSelect=${handleTemplateSelect}
                        creating=${submitting}
                      />
                    `)}
                  </div>
                </div>
              `;
            })}
          ` : html`
            <div class="text-center text-txt-muted text-sm py-4">
              Loading templates...
            </div>
          `}

          ${error && html`<p class="text-sm text-err">${error}</p>`}
          </div>

          <div class="border-t border-border px-6 py-4 flex items-center justify-between">
            <div class="flex gap-4">
              <button
                class="text-sm text-txt-muted hover:text-txt transition-colors"
                onClick=${() => setView('custom')}
              >
                Create blank agent
              </button>
              <button
                class="text-sm text-txt-muted hover:text-txt transition-colors"
                onClick=${() => setView('team')}
              >
                Create team
              </button>
            </div>
            <button
              class="text-sm text-txt-muted hover:text-txt transition-colors"
              onClick=${() => { resetForm(); onClose(); }}
            >
              Cancel
            </button>
          </div>
        </div>

      ` : view === 'name' ? html`
        <form onSubmit=${handleNamedTemplateCreate} class="p-6 flex flex-col gap-4">
          <div>
            <h2 class="text-lg font-semibold">Name Your Agent</h2>
            <p class="text-xs text-txt-2 mt-1">
              A <span class="text-txt font-medium">${selectedTemplate?.name}</span> agent already exists. Pick a different name for this one.
            </p>
          </div>

          <label class="flex flex-col gap-1.5">
            <span class="text-sm text-txt-2">Name</span>
            <input
              type="text"
              class="bg-bg-3 border border-border rounded-lg px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent"
              placeholder="e.g. Project Tracker (Work)"
              value=${name}
              onInput=${onNameInput}
              required
            />
          </label>

          <label class="flex flex-col gap-1.5">
            <span class="text-sm text-txt-2">Folder ID</span>
            <input
              type="text"
              class="bg-bg-3 border border-border rounded-lg px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent font-mono"
              placeholder="e.g. project-tracker-work"
              pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
              value=${folder}
              onInput=${onFolderInput}
              required
            />
          </label>

          ${error && html`<p class="text-sm text-err">${error}</p>`}

          <div class="flex justify-end gap-3 mt-2">
            <button
              type="button"
              class="px-4 py-2 text-sm text-txt-2 hover:text-txt transition-colors"
              onClick=${() => { setView('pick'); setError(''); }}
            >
              Back
            </button>
            <button
              type="submit"
              class="px-4 py-2 bg-accent text-bg font-semibold rounded-lg text-sm hover:brightness-110 disabled:opacity-40 transition-all"
              disabled=${!name.trim() || !folder.trim() || submitting}
            >
              ${submitting ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      ` : view === 'custom' ? html`
        <form onSubmit=${onSubmit} class="p-6 flex flex-col gap-4">
          <div class="flex items-center justify-between">
            <h2 class="text-lg font-semibold">Custom Agent</h2>
            ${initialView !== 'custom' && html`
              <button
                type="button"
                class="text-sm text-txt-muted hover:text-txt transition-colors"
                onClick=${() => setView('pick')}
              >
                Back to templates
              </button>
            `}
          </div>

          <div class="flex flex-col gap-1.5">
            <span class="text-sm text-txt-2">Agent type</span>
            <div class="flex gap-2">
              <button
                type="button"
                class="px-3 py-1.5 text-xs rounded-lg border transition-colors ${pillClass(!isTriggered)}"
                onClick=${() => switchAgentType('standalone')}
              >
                Standalone
              </button>
              <button
                type="button"
                class="px-3 py-1.5 text-xs rounded-lg border transition-colors ${pillClass(isTriggered)}"
                onClick=${() => switchAgentType('triggered')}
              >
                @ Triggered
              </button>
            </div>
            <p class="text-xs text-txt-muted">
              ${isTriggered
                ? 'Invoked via @-mention in any chat. No standalone chat.'
                : 'Gets its own chat thread in the sidebar.'}
            </p>
          </div>

          <label class="flex flex-col gap-1.5">
            <span class="text-sm text-txt-2">Name</span>
            <input
              type="text"
              class="bg-bg-3 border border-border rounded-lg px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent"
              placeholder=${isTriggered ? 'e.g. Weather' : 'e.g. Weather Agent'}
              value=${name}
              onInput=${onNameInput}
              required
            />
          </label>

          <label class="flex flex-col gap-1.5">
            <span class="text-sm text-txt-2">Folder ID</span>
            <input
              type="text"
              class="bg-bg-3 border border-border rounded-lg px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent"
              placeholder="e.g. weather"
              pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
              value=${folder}
              onInput=${onFolderInput}
              required
            />
            <span class="text-xs text-txt-muted">
              Alphanumeric, dashes, underscores. Used for the agent's workspace folder.
            </span>
          </label>

          ${isTriggered && html`
            <label class="flex flex-col gap-1.5">
              <span class="text-sm text-txt-2">Trigger</span>
              <input
                type="text"
                class="bg-bg-3 border border-border rounded-lg px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent font-mono"
                placeholder="@Weather"
                value=${trigger}
                onInput=${(e) => setTrigger(e.target.value)}
                required
              />
              <span class="text-xs text-txt-muted">
                Type this in any chat to invoke the agent.
              </span>
            </label>
          `}

          ${renderProviderModelRow(provider, setProvider, model, setModel)}

          <label class="flex flex-col gap-1.5">
            <span class="text-sm text-txt-2">
              Description${' '}
              ${isTriggered
                ? html`<span class="text-txt-muted">(shown in autocomplete)</span>`
                : html`<span class="text-txt-muted">(optional — sent as first message)</span>`}
            </span>
            <textarea
              class="bg-bg-3 border border-border rounded-lg px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent resize-none"
              rows="3"
              placeholder=${isTriggered
                ? 'What does this agent do? Shown when typing @.'
                : 'What should this agent do? Sent as the first message.'}
              value=${description}
              onInput=${(e) => setDescription(e.target.value)}
              required=${isTriggered}
            />
          </label>

          ${error && html`<p class="text-sm text-err">${error}</p>`}

          <div class="flex justify-end gap-3 mt-2">
            <button
              type="button"
              class="px-4 py-2 text-sm text-txt-2 hover:text-txt transition-colors"
              onClick=${() => { resetForm(); onClose(); }}
            >
              Cancel
            </button>
            <button
              type="submit"
              class="px-4 py-2 bg-accent text-bg font-semibold rounded-lg text-sm hover:brightness-110 disabled:opacity-40 transition-all"
              disabled=${!name.trim() || !folder.trim() || (isTriggered && !description.trim()) || (provider === 'ollama' && !model.trim()) || submitting}
            >
              ${submitting ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      ` : html`
        <form onSubmit=${onTeamSubmit} class="p-6 flex flex-col gap-4 overflow-y-auto" style="max-height: 80vh">
          <div class="flex items-center justify-between">
            <h2 class="text-lg font-semibold">Create Agent Team</h2>
            <button
              type="button"
              class="text-sm text-txt-muted hover:text-txt transition-colors"
              onClick=${() => setView('pick')}
            >
              Back to templates
            </button>
          </div>

          <p class="text-xs text-txt-muted">
            A team has one coordinator that handles messages and delegates to specialists.
          </p>

          <label class="flex flex-col gap-1.5">
            <span class="text-sm text-txt-2">Team name</span>
            <input
              type="text"
              class="bg-bg-3 border border-border rounded-lg px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent"
              placeholder="e.g. Research Team"
              value=${name}
              onInput=${onNameInput}
              required
            />
          </label>

          <label class="flex flex-col gap-1.5">
            <span class="text-sm text-txt-2">Folder ID</span>
            <input
              type="text"
              class="bg-bg-3 border border-border rounded-lg px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent font-mono"
              placeholder="e.g. research-team"
              pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
              value=${folder}
              onInput=${onFolderInput}
              required
            />
          </label>

          <div class="border-t border-border pt-3 flex flex-col gap-2">
            <h3 class="text-sm font-semibold text-txt">Coordinator</h3>
            <p class="text-xs text-txt-muted">Handles all messages and delegates work to specialists.</p>
            <input
              type="text"
              class="bg-bg-3 border border-border rounded-lg px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent"
              placeholder="Display name"
              value=${teamCoordinator.displayName}
              onInput=${(e) => setTeamCoordinator((prev) => ({ ...prev, displayName: e.target.value }))}
            />
            ${renderProviderModelRow(
              teamCoordinator.provider,
              (v) => setTeamCoordinator((prev) => ({ ...prev, provider: v })),
              teamCoordinator.model,
              (v) => setTeamCoordinator((prev) => ({ ...prev, model: v })),
              'Coordinator',
            )}
            <textarea
              class="bg-bg-3 border border-border rounded-lg px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent resize-none"
              rows="2"
              placeholder="Instructions (optional) — what should the coordinator know?"
              value=${teamCoordinator.instructions}
              onInput=${(e) => setTeamCoordinator((prev) => ({ ...prev, instructions: e.target.value }))}
            />
          </div>

          <div class="border-t border-border pt-3 flex flex-col gap-3">
            <div class="flex items-center justify-between">
              <h3 class="text-sm font-semibold text-txt">Specialists</h3>
              <button
                type="button"
                class="text-xs text-accent hover:brightness-110 transition-colors"
                onClick=${addSpecialist}
              >
                + Add specialist
              </button>
            </div>

            ${teamSpecialists.map((spec, i) => html`
              <div key=${i} class="bg-bg-3 border border-border rounded-lg p-3 flex flex-col gap-2">
                <div class="flex items-center justify-between">
                  <span class="text-xs text-txt-muted">Specialist ${i + 1}</span>
                  ${teamSpecialists.length > 1 && html`
                    <button
                      type="button"
                      class="text-xs text-txt-muted hover:text-err transition-colors"
                      onClick=${() => removeSpecialist(i)}
                    >
                      Remove
                    </button>
                  `}
                </div>
                <div class="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    class="bg-bg border border-border rounded-lg px-3 py-1.5 text-sm text-txt focus:outline-none focus:border-accent"
                    placeholder="Name (e.g. analyst)"
                    value=${spec.name}
                    onInput=${(e) => updateSpecialist(i, 'name', e.target.value)}
                  />
                  <input
                    type="text"
                    class="bg-bg border border-border rounded-lg px-3 py-1.5 text-sm text-txt focus:outline-none focus:border-accent font-mono"
                    placeholder="Trigger (e.g. @analyst)"
                    value=${spec.trigger}
                    onInput=${(e) => updateSpecialist(i, 'trigger', e.target.value)}
                  />
                </div>
                <input
                  type="text"
                  class="bg-bg border border-border rounded-lg px-3 py-1.5 text-sm text-txt focus:outline-none focus:border-accent"
                  placeholder="Display name (e.g. Analyst)"
                  value=${spec.displayName}
                  onInput=${(e) => updateSpecialist(i, 'displayName', e.target.value)}
                />
                ${renderProviderModelRow(
                  spec.provider,
                  (v) => updateSpecialist(i, 'provider', v),
                  spec.model,
                  (v) => updateSpecialist(i, 'model', v),
                  'Specialist',
                )}
                <textarea
                  class="bg-bg border border-border rounded-lg px-3 py-1.5 text-sm text-txt focus:outline-none focus:border-accent resize-none"
                  rows="2"
                  placeholder="Instructions — what is this specialist's role?"
                  value=${spec.instructions}
                  onInput=${(e) => updateSpecialist(i, 'instructions', e.target.value)}
                />
              </div>
            `)}
          </div>

          ${error && html`<p class="text-sm text-err">${error}</p>`}

          <div class="flex justify-end gap-3 mt-2">
            <button
              type="button"
              class="px-4 py-2 text-sm text-txt-2 hover:text-txt transition-colors"
              onClick=${() => { resetForm(); onClose(); }}
            >
              Cancel
            </button>
            <button
              type="submit"
              class="px-4 py-2 bg-accent text-bg font-semibold rounded-lg text-sm hover:brightness-110 disabled:opacity-40 transition-all"
              disabled=${!name.trim() || !folder.trim() || !teamSpecialists.some((s) => s.name.trim() && s.trigger.trim()) || submitting}
            >
              ${submitting ? 'Creating...' : 'Create Team'}
            </button>
          </div>
        </form>
      `}
    </dialog>
  `;
}
