import { html } from 'htm/preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import * as api from '../api.js';

function StatusIcon({ status }) {
  if (status === 'ok') {
    return html`<span class="text-green-400 text-lg">✓</span>`;
  }
  if (status === 'loading') {
    return html`<span class="text-txt-muted text-lg animate-pulse">…</span>`;
  }
  return html`<span class="text-red-400 text-lg">✗</span>`;
}

function StatusCard({ title, status, detail, children }) {
  const bg = status === 'ok' ? 'border-green-400/30' : status === 'error' ? 'border-red-400/30' : 'border-border';
  return html`
    <div class="bg-bg-2 border ${bg} rounded-xl p-4 flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <${StatusIcon} status=${status} />
        <span class="text-sm font-semibold text-txt">${title}</span>
      </div>
      ${detail && html`<p class="text-xs text-txt-2">${detail}</p>`}
      ${children}
    </div>
  `;
}

function AnthropicForm({ onRegistered }) {
  const [key, setKey] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleRegister() {
    if (!key.trim()) return;
    setSaving(true);
    setError('');
    try {
      await api.registerAnthropic(key.trim(), endpoint.trim() || undefined);
      setKey('');
      setEndpoint('');
      onRegistered();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return html`
    <div class="mt-2 space-y-2">
      <div>
        <label class="block text-xs text-txt-2 mb-1">API Key</label>
        <input
          type="password"
          class="w-full bg-bg border border-border rounded-lg px-3 py-1.5 text-xs text-txt placeholder-txt-muted focus:outline-none focus:border-accent/50"
          placeholder="sk-ant-..."
          value=${key}
          onInput=${(e) => setKey(e.target.value)}
          onKeyDown=${(e) => e.key === 'Enter' && handleRegister()}
        />
      </div>
      <div>
        <label class="block text-xs text-txt-2 mb-1">Custom endpoint (optional)</label>
        <input
          type="text"
          class="w-full bg-bg border border-border rounded-lg px-3 py-1.5 text-xs text-txt placeholder-txt-muted focus:outline-none focus:border-accent/50"
          placeholder="https://api.anthropic.com"
          value=${endpoint}
          onInput=${(e) => setEndpoint(e.target.value)}
        />
      </div>
      <button
        class="px-3 py-1.5 bg-accent text-bg text-xs font-semibold rounded-lg hover:brightness-110 disabled:opacity-40 transition-all"
        onClick=${handleRegister}
        disabled=${!key.trim() || saving}
      >
        ${saving ? 'Registering...' : 'Register Key'}
      </button>
      ${error && html`<p class="text-xs text-red-400">${error}</p>`}
    </div>
  `;
}

function PathSelector({ onReady }) {
  return html`
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6">
      <button
        class="bg-bg-2 border border-border rounded-xl p-6 text-left hover:border-accent/50 transition-colors group"
        onClick=${() => onReady('user')}
      >
        <h3 class="text-sm font-semibold text-txt mb-2 group-hover:text-accent transition-colors">
          Use Agents
        </h3>
        <p class="text-xs text-txt-2">
          Set up your profile and pick agent templates. Best for getting started quickly.
        </p>
      </button>
      <button
        class="bg-bg-2 border border-border rounded-xl p-6 text-left hover:border-accent/50 transition-colors group"
        onClick=${() => onReady('developer')}
      >
        <h3 class="text-sm font-semibold text-txt mb-2 group-hover:text-accent transition-colors">
          Develop
        </h3>
        <p class="text-xs text-txt-2">
          Contribute to the codebase or build custom templates. Shows dev tools and key files.
        </p>
      </button>
    </div>
  `;
}

export function PrerequisiteCheck({ onReady }) {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [recheckingAnthropic, setRecheckingAnthropic] = useState(false);
  const pollRef = useRef(null);

  async function fetchHealth() {
    try {
      const data = await api.getHealth();
      setHealth(data);
      setLoading(false);

      // Stop polling once everything is ready
      if (data.overall === 'ready' && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchHealth();
    pollRef.current = setInterval(fetchHealth, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  if (loading) {
    return html`
      <div class="flex-1 flex items-center justify-center">
        <p class="text-sm text-txt-muted">Checking prerequisites...</p>
      </div>
    `;
  }

  const allReady = health?.overall === 'ready';

  function dockerStatus() {
    if (!health) return 'loading';
    return health.docker.status === 'running' ? 'ok' : 'error';
  }

  function dockerDetail() {
    if (!health) return '';
    if (health.docker.status === 'running') return `Docker ${health.docker.version || ''} running`;
    if (health.docker.status === 'not_running') return 'Docker is installed but not running';
    return 'Docker not found';
  }

  function credentialProxyStatus() {
    if (!health) return 'loading';
    return health.credential_proxy.status === 'configured' ? 'ok' : 'error';
  }

  function anthropicStatus() {
    if (!health) return 'loading';
    return health.anthropic.status === 'ready' ? 'ok' : 'error';
  }

  function anthropicDetail() {
    if (!health) return '';
    if (health.anthropic.status === 'ready') {
      return health.anthropic.authMode === 'api-key'
        ? 'API key ready'
        : 'OAuth ready';
    }
    if (health.anthropic.status === 'stale') {
      return 'OAuth token is stale or expiring';
    }
    return 'No Anthropic credential available';
  }

  function imageStatus() {
    if (!health) return 'loading';
    return health.container_image.status === 'built' ? 'ok' : 'error';
  }

  async function handleAnthropicRecheck() {
    setRecheckingAnthropic(true);
    try {
      await api.recheckAuthState('anthropic');
      await fetchHealth();
    } finally {
      setRecheckingAnthropic(false);
    }
  }

  return html`
    <div class="flex-1 flex items-center justify-center p-8">
      <div class="max-w-xl w-full">
        <div class="text-center mb-8">
          <h2 class="text-2xl font-bold text-txt mb-1">ClawDad</h2>
          <p class="text-xs text-txt-muted mb-3">Container-native local agent orchestration</p>
          <p class="text-sm text-txt-2">
            ${allReady
              ? 'Everything looks good. Choose how you want to get started.'
              : "Let's make sure everything is set up before we start."}
          </p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <!-- Docker -->
          <${StatusCard}
            title="Docker"
            status=${dockerStatus()}
            detail=${dockerDetail()}
          >
            ${health?.docker.status === 'not_found' && html`
              <a
                href="https://docs.docker.com/get-docker/"
                target="_blank"
                class="text-xs text-accent hover:underline"
              >
                Install Docker Desktop
              </a>
            `}
            ${health?.docker.status === 'not_running' && html`
              <p class="text-xs text-txt-muted">Start Docker Desktop, then this will auto-update.</p>
            `}
          <//>

          <!-- Credential Proxy -->
          <${StatusCard}
            title="Credentials"
            status=${credentialProxyStatus()}
            detail=${health?.credential_proxy.status === 'configured' ? 'Credentials configured in .env' : 'No credentials found'}
          >
            ${health?.credential_proxy.status === 'missing' && html`
              <div class="text-xs text-txt-muted space-y-1">
                <p>Add your API key to .env:</p>
                <code class="block bg-bg px-2 py-1 rounded text-[10px] select-all">echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env</code>
              </div>
            `}
          <//>

          <!-- Anthropic Auth -->
          <${StatusCard}
            title="Anthropic Auth"
            status=${anthropicStatus()}
            detail=${anthropicDetail()}
          >
            ${health?.anthropic.status === 'missing' && html`
              <${AnthropicForm} onRegistered=${fetchHealth} />
            `}
            ${health?.anthropic.status === 'stale' && html`
              <div class="text-xs text-txt-muted space-y-1">
                <p>The configured OAuth token looks stale.</p>
                <p>Refresh your Claude login, then recheck health.</p>
                <button
                  class="mt-1 px-2 py-1 bg-bg border border-border rounded text-[11px] text-txt hover:border-accent/50 disabled:opacity-50"
                  onClick=${handleAnthropicRecheck}
                  disabled=${recheckingAnthropic}
                >
                  ${recheckingAnthropic ? 'Rechecking...' : 'Recheck Auth'}
                </button>
              </div>
            `}
          <//>

          <!-- Container Image -->
          <${StatusCard}
            title="Container Image"
            status=${imageStatus()}
            detail=${health?.container_image.status === 'built'
              ? health.container_image.image
              : `${health?.container_image.image || 'nanoclaw-agent:latest'} not found`}
          >
            ${health?.container_image.status === 'not_found' && html`
              <div class="text-xs text-txt-muted space-y-1">
                <p>Build the agent container:</p>
                <code class="block bg-bg px-2 py-1 rounded text-[10px] select-all">./container/build.sh</code>
              </div>
            `}
          <//>
        </div>

        ${allReady && html`<${PathSelector} onReady=${onReady} />`}

        ${!allReady && html`
          <p class="text-xs text-txt-muted text-center mt-6">
            This page auto-refreshes every 5 seconds. Fix the items above and they'll turn green.
          </p>
        `}
      </div>
    </div>
  `;
}
