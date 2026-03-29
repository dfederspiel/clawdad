import { html } from 'htm/preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { createGroup } from '../app.js';
import * as api from '../api.js';

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

export function NewGroupDialog({ open, onClose }) {
  const dialogRef = useRef(null);
  const [templates, setTemplates] = useState([]);
  const [view, setView] = useState('pick'); // 'pick' | 'name' | 'custom'
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [agentType, setAgentType] = useState('standalone');
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [description, setDescription] = useState('');
  const [trigger, setTrigger] = useState('');
  const [manual, setManual] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      if (dialogRef.current && !dialogRef.current.open) {
        dialogRef.current.showModal();
      }
      setView('pick');
      setError('');
      api.getTemplates().then((data) => setTemplates(data.templates || [])).catch(() => {});
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
      const result = await createGroup(template.name, template.id, template.id);
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

  const isTriggered = agentType === 'triggered';
  const pillClass = (active) => active
    ? 'bg-accent text-bg border-accent font-semibold'
    : 'bg-bg-3 text-txt-2 border-border hover:border-accent/50';

  return html`
    <dialog
      ref=${dialogRef}
      class="bg-bg-2 text-txt border border-border rounded-xl p-0 backdrop:bg-black/60 ${view === 'pick' ? 'max-w-2xl' : 'max-w-md'} w-full max-h-[85vh] flex flex-col overflow-hidden"
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
            <button
              class="text-sm text-txt-muted hover:text-txt transition-colors"
              onClick=${() => setView('custom')}
            >
              Create blank agent
            </button>
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
      ` : html`
        <form onSubmit=${onSubmit} class="p-6 flex flex-col gap-4">
          <div class="flex items-center justify-between">
            <h2 class="text-lg font-semibold">Custom Agent</h2>
            <button
              type="button"
              class="text-sm text-txt-muted hover:text-txt transition-colors"
              onClick=${() => setView('pick')}
            >
              Back to templates
            </button>
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
              disabled=${!name.trim() || !folder.trim() || (isTriggered && !description.trim()) || submitting}
            >
              ${submitting ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      `}
    </dialog>
  `;
}
