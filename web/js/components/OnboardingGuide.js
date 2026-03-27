import { html } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import { createGroup, handleSend } from '../app.js';
import * as api from '../api.js';
import { SetupWizard } from './SetupWizard.js';

function TemplateCard({ template, onSelect, creating }) {
  return html`
    <div
      class="bg-bg-2 border border-border rounded-xl p-5 flex flex-col gap-3 hover:border-accent/50 transition-colors"
    >
      <h3 class="text-sm font-semibold text-txt">${template.name}</h3>
      <p class="text-xs text-txt-2 flex-1">${template.description}</p>
      <button
        class="self-start px-3 py-1.5 bg-accent text-bg text-xs font-semibold rounded-lg hover:brightness-110 disabled:opacity-40 transition-all"
        onClick=${() => onSelect(template)}
        disabled=${creating}
      >
        Create
      </button>
    </div>
  `;
}

export function OnboardingGuide({ onCustom }) {
  const [templates, setTemplates] = useState([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [configLoaded, setConfigLoaded] = useState(false);
  const [hasConfig, setHasConfig] = useState(false);

  useEffect(() => {
    // Check if global config exists before showing templates
    api.getConfig().then((config) => {
      setHasConfig(config && Object.keys(config).length > 0);
      setConfigLoaded(true);
    }).catch(() => {
      setConfigLoaded(true);
    });
    api.getTemplates().then((data) => setTemplates(data.templates)).catch(() => {});
  }, []);

  async function handleSelect(template) {
    setCreating(true);
    setError('');
    try {
      await createGroup(template.name, template.id, template.id);
      // Kickstart the agent — triggers its first-run setup flow
      await handleSend('Hello! Help me get set up.');
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  // Still loading config check
  if (!configLoaded) {
    return html`
      <div class="flex-1 flex items-center justify-center">
        <p class="text-sm text-txt-muted">Loading...</p>
      </div>
    `;
  }

  // No config yet — show setup wizard first
  if (!hasConfig) {
    return html`<${SetupWizard} onComplete=${() => setHasConfig(true)} />`;
  }

  // Config exists — show template picker
  return html`
    <div class="flex-1 flex items-center justify-center p-8">
      <div class="max-w-2xl w-full">
        <div class="text-center mb-8">
          <h2 class="text-2xl font-bold text-txt mb-1">
            ClawDad
          </h2>
          <p class="text-xs text-txt-muted mb-3">NanoClaw Agent Orchestrator</p>
          <p class="text-sm text-txt-2">
            Pick a template to create your first agent. Each runs isolated with
            its own workspace — the agent will walk you through setup in chat.
          </p>
        </div>

        ${templates.length > 0
          ? html`
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                ${templates.map(
                  (t) =>
                    html`<${TemplateCard}
                      key=${t.id}
                      template=${t}
                      onSelect=${handleSelect}
                      creating=${creating}
                    />`,
                )}
              </div>
            `
          : html`
              <div class="text-center text-txt-muted text-sm py-8">
                Loading templates...
              </div>
            `}

        <div class="text-center">
          <button
            class="text-sm text-txt-muted hover:text-txt transition-colors"
            onClick=${onCustom}
          >
            or create a custom agent group
          </button>
        </div>

        ${error && html`<p class="text-sm text-err text-center mt-4">${error}</p>`}
      </div>
    </div>
  `;
}
