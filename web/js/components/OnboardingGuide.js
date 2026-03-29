import { html } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import { createGroup, handleSend } from '../app.js';
import * as api from '../api.js';
import { PrerequisiteCheck } from './PrerequisiteCheck.js';
import { SetupWizard } from './SetupWizard.js';

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
  const tierBadge = {
    beginner: 'bg-green-500/10 text-green-400',
    advanced: 'bg-purple-500/10 text-purple-400',
    recipe: 'bg-bg-3 text-txt-muted',
  };
  const tier = template.tier || 'recipe';

  return html`
    <div
      class="bg-bg-2 border rounded-xl p-5 flex flex-col gap-3 transition-colors ${tierColors[tier] || tierColors.recipe}"
    >
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-txt">${template.name}</h3>
        <span class="text-[10px] px-1.5 py-0.5 rounded ${tierBadge[tier] || tierBadge.recipe}">
          ${tier === 'beginner' ? 'Beginner' : tier === 'advanced' ? 'Advanced' : 'Recipe'}
        </span>
      </div>
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

export function OnboardingGuide({ onCustom, compact = false }) {
  const [templates, setTemplates] = useState([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [configLoaded, setConfigLoaded] = useState(compact); // skip config check in compact mode
  const [hasConfig, setHasConfig] = useState(compact); // skip setup wizard in compact mode
  const [healthReady, setHealthReady] = useState(compact ? true : null); // skip health in compact
  const [userPath, setUserPath] = useState(compact ? 'user' : null);

  useEffect(() => {
    if (!compact) {
      // Step 1: Check prerequisites
      api.getHealth().then((health) => {
        setHealthReady(health.overall === 'ready');
      }).catch(() => {
        setHealthReady(true);
      });

      // Pre-fetch config
      api.getConfig().then((config) => {
        setHasConfig(config && Object.keys(config).length > 0);
        setConfigLoaded(true);
      }).catch(() => {
        setConfigLoaded(true);
      });
    }

    // Always fetch templates
    api.getTemplates().then((data) => setTemplates(data.templates)).catch(() => {});
  }, [compact]);

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

  // Full onboarding flow (not compact)
  if (!compact) {
    // Step 1: Prerequisites
    if (healthReady === null) {
      return html`
        <div class="flex-1 flex items-center justify-center">
          <p class="text-sm text-txt-muted">Checking prerequisites...</p>
        </div>
      `;
    }

    if (healthReady === false || (healthReady === true && !userPath)) {
      if (healthReady === false) {
        return html`<${PrerequisiteCheck} onReady=${(path) => { setHealthReady(true); setUserPath(path); }} />`;
      }
      return html`<${PrerequisiteCheck} onReady=${(path) => setUserPath(path)} />`;
    }

    // Step 2: Loading
    if (!configLoaded) {
      return html`
        <div class="flex-1 flex items-center justify-center">
          <p class="text-sm text-txt-muted">Loading...</p>
        </div>
      `;
    }

    // Step 3: Setup wizard
    if (!hasConfig) {
      return html`<${SetupWizard} userPath=${userPath} onComplete=${() => setHasConfig(true)} />`;
    }
  }

  // Template picker — shown in both full and compact modes
  return html`
    <div class="flex-1 overflow-y-auto p-8">
      <div class="max-w-2xl w-full mx-auto">
        <div class="text-center mb-8">
          ${compact ? html`
            <p class="text-sm text-txt-2">
              Create a new agent from a template, or select a group from the sidebar.
            </p>
          ` : html`
            <h2 class="text-2xl font-bold text-txt mb-1">ClawDad</h2>
            <p class="text-xs text-txt-muted mb-3">NanoClaw Agent Orchestrator</p>
            <p class="text-sm text-txt-2">
              Pick a template to create your first agent. Each runs isolated with
              its own workspace — the agent will walk you through setup in chat.
            </p>
          `}
        </div>

        ${templates.length > 0
          ? html`
              ${TIER_ORDER.filter((tier) => templates.some((t) => (t.tier || 'recipe') === tier)).map((tier) => {
                const tierTemplates = templates.filter((t) => (t.tier || 'recipe') === tier);
                const meta = TIER_META[tier] || TIER_META.recipe;
                return html`
                  <div class="mb-6" key=${tier}>
                    <div class="mb-3">
                      <h3 class="text-sm font-semibold text-txt">${meta.label}</h3>
                      <p class="text-xs text-txt-muted">${meta.desc}</p>
                    </div>
                    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      ${tierTemplates.map(
                        (t) =>
                          html`<${TemplateCard}
                            key=${t.id}
                            template=${t}
                            onSelect=${handleSelect}
                            creating=${creating}
                          />`,
                      )}
                    </div>
                  </div>
                `;
              })}
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
