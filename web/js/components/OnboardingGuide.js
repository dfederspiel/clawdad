import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { createGroup } from '../app.js';

const TEMPLATES = [
  {
    id: 'deployments',
    name: 'Deployment Agent',
    description:
      'Monitor CI/CD pipelines, trigger deployments, investigate failures, and track security gates.',
    folder: 'deployments',
  },
  {
    id: 'updates',
    name: 'Updates Agent',
    description:
      'Daily check-ins, weekly status reports, Jira activity tracking, and Confluence integration.',
    folder: 'updates',
  },
  {
    id: 'bug-triage',
    name: 'Bug Triage Agent',
    description:
      'Auto-triage Jira bugs, investigate code, propose fixes, and create pull requests.',
    folder: 'bug-triage',
  },
];

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
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  async function handleSelect(template) {
    setCreating(true);
    setError('');
    try {
      await createGroup(template.name, template.folder, template.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  return html`
    <div class="flex-1 flex items-center justify-center p-8">
      <div class="max-w-2xl w-full">
        <div class="text-center mb-8">
          <h2 class="text-xl font-semibold text-txt mb-2">
            Welcome to NanoClaw
          </h2>
          <p class="text-sm text-txt-2">
            Get started by creating an agent group from a template, or create a
            custom one.
          </p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          ${TEMPLATES.map(
            (t) =>
              html`<${TemplateCard}
                key=${t.id}
                template=${t}
                onSelect=${handleSelect}
                creating=${creating}
              />`,
          )}
        </div>

        <div class="text-center">
          <button
            class="text-sm text-txt-muted hover:text-txt transition-colors"
            onClick=${onCustom}
          >
            or create a custom agent group
          </button>
        </div>

        ${error && html`<p class="text-sm text-err text-center mt-4">${error}</p>`}

        <p class="text-xs text-txt-muted text-center mt-6">
          Each group runs an isolated Claude agent with its own workspace and
          memory. Templates include a guided setup that configures the agent on
          first message.
        </p>
      </div>
    </div>
  `;
}
