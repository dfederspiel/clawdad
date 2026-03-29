import { html } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import * as api from '../api.js';

// Guess timezone from browser
function guessTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return '';
  }
}

export function SetupWizard({ onComplete, userPath }) {
  const [steps, setSteps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(0);
  const [data, setData] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Load setup fields from active pack
  useEffect(() => {
    api.getPack().then((pack) => {
      const packSteps = pack.setup || [];

      // Append dev step if developer path
      if (userPath === 'developer') {
        packSteps.push({
          title: 'Developer Tools',
          subtitle: 'Key files and commands for working on the codebase.',
          info: true,
          fields: [],
        });
      }

      // Fallback if pack has no setup fields
      if (packSteps.length === 0) {
        packSteps.push({
          title: 'About You',
          subtitle: "So your agents know who they're working for.",
          fields: [
            { key: 'user_name', label: 'Name', placeholder: 'Jane Smith', required: true },
          ],
        });
      }

      setSteps(packSteps);

      // Pre-fill timezone if there's a timezone field
      const hasTimezone = packSteps.some((s) =>
        s.fields?.some((f) => f.type === 'timezone' || f.key === 'timezone'),
      );
      if (hasTimezone) {
        setData((d) => ({ ...d, timezone: guessTimezone() }));
      }

      setLoading(false);
    }).catch(() => {
      setSteps([{
        title: 'About You',
        subtitle: "So your agents know who they're working for.",
        fields: [
          { key: 'user_name', label: 'Name', placeholder: 'Jane Smith', required: true },
        ],
      }]);
      setLoading(false);
    });
  }, [userPath]);

  if (loading) {
    return html`
      <div class="flex-1 flex items-center justify-center">
        <p class="text-sm text-txt-muted">Loading...</p>
      </div>
    `;
  }

  const current = steps[step];
  const isLast = step === steps.length - 1;
  const isFirst = step === 0;

  function updateField(key, value) {
    setData({ ...data, [key]: value });
  }

  function canAdvance() {
    if (!current.fields) return true;
    return current.fields
      .filter((f) => f.required)
      .every((f) => (data[f.key] || '').trim());
  }

  async function handleNext() {
    if (isLast) {
      setSaving(true);
      setError('');
      try {
        const config = {};
        for (const [k, v] of Object.entries(data)) {
          if (typeof v === 'string' && v.trim()) config[k] = v.trim();
        }
        await api.saveConfig(config);
        onComplete(config);
      } catch (err) {
        setError(err.message);
      } finally {
        setSaving(false);
      }
    } else {
      setStep(step + 1);
    }
  }

  function handleBack() {
    if (!isFirst) setStep(step - 1);
  }

  function handleSkip() {
    if (isLast) {
      handleNext();
    } else {
      setStep(step + 1);
    }
  }

  return html`
    <div class="flex-1 flex items-center justify-center p-8">
      <div class="max-w-md w-full">
        <div class="text-center mb-8">
          <h2 class="text-2xl font-bold text-txt mb-1">ClawDad</h2>
          <p class="text-xs text-txt-muted mb-6">NanoClaw Agent Orchestrator</p>
          <div class="flex items-center justify-center gap-2 mb-6">
            ${steps.map(
              (_, i) => html`
                <div
                  class="h-1 w-8 rounded-full transition-colors ${
                    i <= step ? 'bg-accent' : 'bg-bg-3'
                  }"
                />
              `,
            )}
          </div>
          <h3 class="text-lg font-semibold text-txt mb-1">${current.title}</h3>
          <p class="text-xs text-txt-2">${current.subtitle}</p>
        </div>

        ${current.info
          ? html`
              <div class="space-y-3 mb-6 text-xs text-txt-2">
                <div class="bg-bg-2 border border-border rounded-lg p-3">
                  <p class="font-semibold text-txt mb-2">Key Files</p>
                  <table class="w-full">
                    <tr><td class="py-0.5 text-accent font-mono">src/index.ts</td><td>Orchestrator, message loop</td></tr>
                    <tr><td class="py-0.5 text-accent font-mono">src/container-runner.ts</td><td>Spawns agent containers</td></tr>
                    <tr><td class="py-0.5 text-accent font-mono">src/channels/web.ts</td><td>Web UI channel + API</td></tr>
                    <tr><td class="py-0.5 text-accent font-mono">src/health.ts</td><td>Prerequisite checks</td></tr>
                    <tr><td class="py-0.5 text-accent font-mono">clawdoodles/</td><td>Packs and templates</td></tr>
                    <tr><td class="py-0.5 text-accent font-mono">container/</td><td>Agent container image</td></tr>
                  </table>
                </div>
                <div class="bg-bg-2 border border-border rounded-lg p-3">
                  <p class="font-semibold text-txt mb-2">Dev Commands</p>
                  <code class="block bg-bg px-2 py-1 rounded mb-1 select-all">npm run dev</code>
                  <code class="block bg-bg px-2 py-1 rounded mb-1 select-all">npm run build</code>
                  <code class="block bg-bg px-2 py-1 rounded mb-1 select-all">./container/build.sh</code>
                </div>
                <p>See <span class="text-accent font-mono">CONTRIBUTING.md</span> for skill types and PR guidelines.</p>
              </div>
            `
          : html`
              <div class="space-y-4 mb-6">
                ${current.fields.map(
                  (field) => html`
                    <div>
                      <label class="block text-xs text-txt-2 mb-1">
                        ${field.label}${field.required ? ' *' : ''}
                      </label>
                      <input
                        type=${field.type === 'secret' ? 'password' : 'text'}
                        class="w-full bg-bg-2 border border-border rounded-lg px-3 py-2 text-sm text-txt placeholder-txt-muted focus:outline-none focus:border-accent/50 transition-colors"
                        placeholder=${field.placeholder || ''}
                        value=${data[field.key] || ''}
                        onInput=${(e) => updateField(field.key, e.target.value)}
                        onKeyDown=${(e) => e.key === 'Enter' && canAdvance() && handleNext()}
                      />
                    </div>
                  `,
                )}
              </div>
            `}

        <div class="flex items-center justify-between">
          <div>
            ${!isFirst
              ? html`
                  <button
                    class="text-sm text-txt-muted hover:text-txt transition-colors"
                    onClick=${handleBack}
                  >
                    Back
                  </button>
                `
              : null}
          </div>
          <div class="flex items-center gap-3">
            ${current.fields && !current.fields.some((f) => f.required)
              ? html`
                  <button
                    class="text-sm text-txt-muted hover:text-txt transition-colors"
                    onClick=${handleSkip}
                  >
                    Skip
                  </button>
                `
              : null}
            <button
              class="px-4 py-2 bg-accent text-bg text-sm font-semibold rounded-lg hover:brightness-110 disabled:opacity-40 transition-all"
              onClick=${handleNext}
              disabled=${!canAdvance() || saving}
            >
              ${saving ? 'Saving...' : isLast ? 'Done' : 'Next'}
            </button>
          </div>
        </div>

        ${error &&
        html`<p class="text-sm text-err text-center mt-4">${error}</p>`}
      </div>
    </div>
  `;
}
