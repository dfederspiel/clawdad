import { html } from 'htm/preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { createGroup, handleSend } from '../app.js';
import * as api from '../api.js';

export function NewGroupDialog({ open, onClose }) {
  const dialogRef = useRef(null);
  const [templates, setTemplates] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState(null); // null = blank
  const [agentType, setAgentType] = useState('standalone'); // 'standalone' | 'triggered'
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
      api.getTemplates().then((data) => setTemplates(data.templates || [])).catch(() => {});
    } else if (dialogRef.current?.open) {
      dialogRef.current.close();
    }
  }, [open]);

  function slugify(val) {
    return val.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'group';
  }

  function selectTemplate(t) {
    setSelectedTemplate(t);
    if (t) {
      setName(t.name);
      setFolder(t.id);
      setManual(false);
    } else {
      setName('');
      setFolder('');
      setManual(false);
    }
    setDescription('');
    setError('');
  }

  function onNameInput(e) {
    const val = e.target.value;
    setName(val);
    if (!manual) setFolder(slugify(val));
    // Auto-update trigger when name changes (for triggered agents)
    if (agentType === 'triggered') {
      setTrigger(`@${val}`);
    }
  }

  function onFolderInput(e) {
    setManual(true);
    setFolder(e.target.value);
  }

  function switchAgentType(type) {
    setAgentType(type);
    if (type === 'triggered') {
      setSelectedTemplate(null);
      setTrigger(name ? `@${name}` : '');
    } else {
      setTrigger('');
    }
    setError('');
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

      await createGroup(
        name.trim(),
        folder.trim(),
        selectedTemplate ? selectedTemplate.id : undefined,
        opts,
      );

      // Standalone: send first message or kickstart
      if (agentType === 'standalone') {
        if (!selectedTemplate && description.trim()) {
          await handleSend(description.trim());
        }
        if (selectedTemplate) {
          await handleSend('Hello! Help me get set up.');
        }
      }

      // Reset form
      setName('');
      setFolder('');
      setDescription('');
      setTrigger('');
      setSelectedTemplate(null);
      setAgentType('standalone');
      setManual(false);
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
      class="bg-bg-2 text-txt border border-border rounded-xl p-0 backdrop:bg-black/60 max-w-md w-full"
      onClose=${onClose}
    >
      <form onSubmit=${onSubmit} class="p-6 flex flex-col gap-4">
        <h2 class="text-lg font-semibold">New Agent</h2>

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

        ${!isTriggered && templates.length > 0 && html`
          <div class="flex flex-col gap-1.5">
            <span class="text-sm text-txt-2">Start from</span>
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="px-3 py-1.5 text-xs rounded-lg border transition-colors ${pillClass(!selectedTemplate)}"
                onClick=${() => selectTemplate(null)}
              >
                Blank
              </button>
              ${['beginner', 'advanced', 'recipe']
                .filter((tier) => templates.some((t) => (t.tier || 'recipe') === tier))
                .map((tier) => {
                  const tierTemplates = templates.filter((t) => (t.tier || 'recipe') === tier);
                  return tierTemplates.map((t) => html`
                    <button
                      type="button"
                      key=${t.id}
                      class="px-3 py-1.5 text-xs rounded-lg border transition-colors ${pillClass(selectedTemplate?.id === t.id)}"
                      onClick=${() => selectTemplate(t)}
                      title=${t.description}
                    >
                      ${t.name}${' '}
                      ${tier === 'beginner' ? html`<span class="text-green-400 text-[8px]">*</span>` : ''}
                    </button>
                  `);
                })}
            </div>
            ${selectedTemplate && html`
              <p class="text-xs text-txt-muted">${selectedTemplate.description}</p>
            `}
          </div>
        `}

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
              : html`<span class="text-txt-muted">(optional)</span>`}
          </span>
          <textarea
            class="bg-bg-3 border border-border rounded-lg px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent resize-none"
            rows="3"
            placeholder=${isTriggered
              ? 'What does this agent do? Shown when typing @.'
              : 'What should this agent do? The agent will receive this as its first message.'}
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
            onClick=${onClose}
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
    </dialog>
  `;
}
