// API client + SSE

async function fetchJson(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// SSE
let eventSource = null;
const listeners = new Map();

export function connectSSE(clientId) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/events?clientId=${clientId}`);
  eventSource.onerror = () => console.warn('SSE reconnecting...');

  for (const [event, cbs] of listeners) {
    eventSource.addEventListener(event, (e) => {
      const data = JSON.parse(e.data);
      for (const cb of cbs) cb(data);
    });
  }
}

export function onSSE(event, cb) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(cb);
  if (eventSource) {
    eventSource.addEventListener(event, (e) => cb(JSON.parse(e.data)));
  }
}

// API methods
export const getGroups = () => fetchJson('/api/groups');
export const getTemplates = () => fetchJson('/api/templates');
export const getConfig = () => fetchJson('/api/config');
export const saveConfig = (data) =>
  fetchJson('/api/config', { method: 'POST', body: data });

export const createGroup = (name, folder, template, opts = {}) =>
  fetchJson('/api/groups', { method: 'POST', body: { name, folder, template, ...opts } });

export const getTriggers = () => fetchJson('/api/triggers');

export const deleteGroup = (folder) =>
  fetchJson(`/api/groups/${encodeURIComponent(folder)}`, { method: 'DELETE' });

export const getMessages = (jid, since) =>
  fetchJson(`/api/messages/${encodeURIComponent(jid)}${since ? `?since=${since}` : ''}`);

export const sendMessage = (jid, content, sender, threadId) =>
  fetchJson('/api/send', { method: 'POST', body: { jid, content, sender, thread_id: threadId } });

export const getThreads = (jid) =>
  fetchJson(`/api/threads/${encodeURIComponent(jid)}`);

export const getThreadMessages = (threadId) =>
  fetchJson(`/api/thread-messages/${encodeURIComponent(threadId)}`);

export const clearMessages = (jid) =>
  fetchJson(`/api/messages/${encodeURIComponent(jid)}`, { method: 'DELETE' });

// Health & onboarding
export const getHealth = () => fetchJson('/api/health');
export const registerAnthropic = (key, customEndpoint) =>
  fetchJson('/api/register-anthropic', {
    method: 'POST',
    body: { key, customEndpoint },
  });

// Status & telemetry
export const getStatus = () => fetchJson('/api/status');
export const getTasks = () => fetchJson('/api/tasks');
export const getTaskLogs = (taskId, limit = 20) =>
  fetchJson(`/api/tasks/${encodeURIComponent(taskId)}/logs?limit=${limit}`);
export const pauseTask = (taskId) =>
  fetchJson(`/api/tasks/${encodeURIComponent(taskId)}/pause`, { method: 'POST' });
export const resumeTask = (taskId) =>
  fetchJson(`/api/tasks/${encodeURIComponent(taskId)}/resume`, { method: 'POST' });
export const cancelTask = (taskId) =>
  fetchJson(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
export const getTelemetry = () => fetchJson('/api/telemetry');
export const getAchievements = () => fetchJson('/api/achievements');
