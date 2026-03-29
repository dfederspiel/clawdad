import { html } from 'htm/preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { credentialRequest } from '../app.js';
import * as api from '../api.js';

const SERVICE_META = {
  atlassian: {
    label: 'Atlassian API Token',
    help: 'Create one at id.atlassian.com/manage-profile/security/api-tokens',
    defaultHost: '*.atlassian.net',
    needsEmail: true,
  },
  github: {
    label: 'GitHub Personal Access Token',
    help: 'Create at github.com/settings/tokens (repo scope minimum)',
    defaultHost: '*.github.com',
  },
  gitlab: {
    label: 'GitLab Access Token',
    help: 'Create at Settings > Access Tokens',
    defaultHost: 'gitlab.com',
  },
  harness: {
    label: 'Harness API Key',
    help: 'From Account Settings > API Keys',
    defaultHost: 'app.harness.io',
  },
  launchdarkly: {
    label: 'LaunchDarkly API Key',
    help: 'From Account Settings > Authorization',
    defaultHost: 'app.launchdarkly.com',
  },
};

export function CredentialModal() {
  const dialogRef = useRef(null);
  const request = credentialRequest.value;
  const [key, setKey] = useState('');
  const [email, setEmail] = useState('');
  const [hostPattern, setHostPattern] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const meta = request ? SERVICE_META[request.service] : null;
  const isCustom = request && !meta;
  const needsEmail = meta?.needsEmail || request?.email;
  const label = meta?.label || `${request?.service || 'Service'} API Key`;

  useEffect(() => {
    if (request) {
      if (dialogRef.current && !dialogRef.current.open) {
        dialogRef.current.showModal();
      }
      setKey('');
      setEmail(request.email || '');
      setHostPattern(request.hostPattern || meta?.defaultHost || '');
      setError('');
      setSuccess(false);
    } else if (dialogRef.current?.open) {
      dialogRef.current.close();
    }
  }, [request]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!key.trim()) return;
    setSaving(true);
    setError('');
    try {
      await api.registerCredential(request.service, key.trim(), {
        email: email.trim() || undefined,
        hostPattern: hostPattern.trim() || undefined,
        groupFolder: request.groupFolder,
      });
      setSuccess(true);
      setTimeout(() => {
        credentialRequest.value = null;
        setSuccess(false);
      }, 1500);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    credentialRequest.value = null;
  }

  if (!request) return null;

  return html`
    <dialog
      ref=${dialogRef}
      class="bg-bg-2 text-txt border border-border rounded-xl p-0 backdrop:bg-black/60 max-w-md w-full"
      onClose=${handleCancel}
    >
      <form onSubmit=${handleSubmit} class="p-6 flex flex-col gap-4">
        <div>
          <h2 class="text-lg font-semibold">${label}</h2>
          ${request.description && html`
            <p class="text-xs text-txt-2 mt-1">${request.description}</p>
          `}
        </div>

        ${meta?.help && html`
          <div class="bg-bg-3 border border-border rounded-lg px-3 py-2">
            <p class="text-xs text-txt-2">${meta.help}</p>
          </div>
        `}

        <label class="flex flex-col gap-1.5">
          <span class="text-sm text-txt-2">Secret / API Key</span>
          <input
            type="password"
            class="bg-bg-3 border border-border rounded-lg px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent"
            placeholder=${meta ? 'Paste your token here' : 'API key or token'}
            value=${key}
            onInput=${(e) => setKey(e.target.value)}
            required
            autocomplete="off"
          />
          <span class="text-xs text-txt-muted">
            Stored in an encrypted vault. The agent never sees this value.
          </span>
        </label>

        ${needsEmail && html`
          <label class="flex flex-col gap-1.5">
            <span class="text-sm text-txt-2">Email</span>
            <input
              type="email"
              class="bg-bg-3 border border-border rounded-lg px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent"
              placeholder="you@example.com"
              value=${email}
              onInput=${(e) => setEmail(e.target.value)}
              ${request.service === 'atlassian' ? 'required' : ''}
            />
          </label>
        `}

        ${(isCustom || request.hostPattern) && html`
          <label class="flex flex-col gap-1.5">
            <span class="text-sm text-txt-2">Host Pattern</span>
            <input
              type="text"
              class="bg-bg-3 border border-border rounded-lg px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent font-mono"
              placeholder="*.example.com"
              value=${hostPattern}
              onInput=${(e) => setHostPattern(e.target.value)}
              ${isCustom ? 'required' : ''}
            />
            <span class="text-xs text-txt-muted">
              Which hosts should receive this credential.
            </span>
          </label>
        `}

        ${success && html`
          <div class="bg-green-500/10 border border-green-500/30 rounded-lg px-3 py-2 text-center">
            <p class="text-sm text-green-400 font-semibold">Credential registered!</p>
          </div>
        `}

        ${error && html`<p class="text-sm text-err">${error}</p>`}

        ${!success && html`
          <div class="flex justify-end gap-3 mt-2">
            <button
              type="button"
              class="px-4 py-2 text-sm text-txt-2 hover:text-txt transition-colors"
              onClick=${handleCancel}
            >
              Cancel
            </button>
            <button
              type="submit"
              class="px-4 py-2 bg-accent text-bg font-semibold rounded-lg text-sm hover:brightness-110 disabled:opacity-40 transition-all"
              disabled=${!key.trim() || saving}
            >
              ${saving ? 'Registering...' : 'Register'}
            </button>
          </div>
        `}

        <p class="text-[10px] text-txt-muted text-center">
          For advanced credential management, use the CLI: onecli secrets create
        </p>
      </form>
    </dialog>
  `;
}
