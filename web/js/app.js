import { render } from 'preact';
import { signal, computed } from 'preact/signals';
import { html } from 'htm/preact';
import * as api from './api.js';
import { App } from './components/App.js';
import { showAchievementToast } from './components/blocks/AchievementToast.js';
import { loadAchievements, handleAchievementSSE } from './achievements.js';
import {
  THEMES, applyTheme, getThemeByName, validateThemeJson,
  buildExportJson, getCurrentColors,
} from './themes.js';

// --- Global State (signals) ---

export const groups = signal([]);
export const selectedJid = signal(null);
export const messages = signal([]);
export const typingGroups = signal({}); // { [jid]: boolean }
export const typing = computed(() => typingGroups.value[selectedJid.value] || false);
export const unread = signal({}); // { [jid]: count }
export const threadMeta = signal({}); // { [messageId]: ThreadInfo }
export const openThreads = signal({}); // { [threadId]: Message[] }
export const threadTyping = signal({}); // { [threadId]: boolean }
export const credentialQueue = signal([]); // queued credential requests
export const credentialRequest = signal(null); // current active request

export const selectedGroup = computed(() =>
  groups.value.find((g) => g.jid === selectedJid.value) || null,
);

// Status, tasks, telemetry (polled), and triggers (for @-mention autocomplete)
export const status = signal(null);
export const tasks = signal([]);
export const telemetry = signal(null);
export const triggers = signal([]);
export const usage = signal(null); // latest usage stats
export const lastRunUsage = signal({}); // { [jid]: UsageData } — per-group latest run
export const typingStartTime = signal({}); // { [jid]: timestamp } — when typing started

// --- SSE ---

const clientId = crypto.randomUUID();
api.connectSSE(clientId);

api.onSSE('message', (data) => {
  if (data.thread_id) {
    // Thread message — append to open thread, update reply count, clear thread typing
    threadTyping.value = { ...threadTyping.value, [data.thread_id]: false };
    const threads = openThreads.value;
    if (threads[data.thread_id]) {
      openThreads.value = {
        ...threads,
        [data.thread_id]: [...threads[data.thread_id], {
          role: 'assistant', content: data.text, timestamp: data.timestamp,
        }],
      };
    }
    // Bump reply count in threadMeta
    const meta = threadMeta.value[data.thread_id];
    if (meta) {
      threadMeta.value = {
        ...threadMeta.value,
        [data.thread_id]: { ...meta, reply_count: (meta.reply_count || 0) + 1 },
      };
    }
    return;
  }

  // Clear typing for this group regardless of selection
  typingGroups.value = { ...typingGroups.value, [data.jid]: false };

  if (data.jid === selectedJid.value) {
    messages.value = [
      ...messages.value,
      {
        role: 'assistant',
        content: data.text,
        timestamp: data.timestamp,
      },
    ];
  } else {
    // Track unread for non-selected groups
    const cur = unread.value;
    unread.value = { ...cur, [data.jid]: (cur[data.jid] || 0) + 1 };
  }
});

api.onSSE('typing', (data) => {
  if (data.thread_id) {
    threadTyping.value = { ...threadTyping.value, [data.thread_id]: data.isTyping };
    return;
  }
  typingGroups.value = { ...typingGroups.value, [data.jid]: data.isTyping };
  // Track when typing started for elapsed time display
  if (data.isTyping) {
    if (!typingStartTime.value[data.jid]) {
      typingStartTime.value = { ...typingStartTime.value, [data.jid]: Date.now() };
    }
  } else {
    const next = { ...typingStartTime.value };
    delete next[data.jid];
    typingStartTime.value = next;
  }
});

api.onSSE('usage_update', (data) => {
  lastRunUsage.value = { ...lastRunUsage.value, [data.jid]: data };
  // Attach usage to the last assistant message for the current view
  if (data.jid === selectedJid.value) {
    const msgs = [...messages.value];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant' && !msgs[i].usage) {
        msgs[i] = { ...msgs[i], usage: data };
        messages.value = msgs;
        break;
      }
    }
  }
});

api.onSSE('thread_created', async (data) => {
  // A new thread was created by a trigger — add to threadMeta so UI shows immediately
  if (data.jid === selectedJid.value && data.thread_id) {
    threadMeta.value = {
      ...threadMeta.value,
      [data.thread_id]: {
        thread_id: data.thread_id,
        agent_jid: '',
        origin_jid: data.jid,
        agent_name: data.agent_name,
        created_at: new Date().toISOString(),
        reply_count: 0,
      },
    };
    // Reload messages from server so optimistic messages get proper IDs
    // (thread indicators match by message ID)
    const msgData = await api.getMessages(data.jid);
    messages.value = msgData.messages.map((m) => ({
      id: m.id,
      role: m.is_bot_message || m.is_from_me ? 'assistant' : 'user',
      content: m.content,
      timestamp: m.timestamp,
      senderName: m.sender_name,
    }));
  }
});

api.onSSE('user_message', (data) => {
  // Skip thread reply echo — optimistic update already added it
  if (data.message?.thread_id) return;
  // Ignore echo for normal messages — optimistic update already shows them
});

api.onSSE('achievement', (data) => {
  const enriched = handleAchievementSSE(data);
  showAchievementToast(enriched);
});

api.onSSE('messages_cleared', (data) => {
  if (data.jid === selectedJid.value) {
    messages.value = [];
    threadMeta.value = {};
    openThreads.value = {};
    threadTyping.value = {};
  }
});

api.onSSE('groups_changed', () => {
  loadGroups();
});

api.onSSE('credential_request', (data) => {
  // Queue requests — show one at a time
  if (credentialRequest.value) {
    credentialQueue.value = [...credentialQueue.value, data];
  } else {
    credentialRequest.value = data;
  }
});

// --- Actions ---

export async function loadGroups() {
  const data = await api.getGroups();
  groups.value = data.groups;

  // Auto-select main group (or first) if nothing is selected.
  // Don't auto-select if only system groups exist — show onboarding instead.
  const hasTemplateGroups = data.groups.some((g) => !g.isSystem);
  if (!selectedJid.value && data.groups.length > 0 && hasTemplateGroups) {
    const main = data.groups.find((g) => g.isMain && !g.isSystem)
      || data.groups.find((g) => !g.isSystem);
    if (main) selectGroup(main.jid);
  }
}

export async function selectGroup(jid) {
  selectedJid.value = jid;

  // Clear unread for this group
  const cur = { ...unread.value };
  delete cur[jid];
  unread.value = cur;

  // Clear messages before fetch so SSE messages arriving during the fetch
  // are appended to a clean slate (selectedJid is already set above).
  messages.value = [];

  const [msgData, threadData] = await Promise.all([
    api.getMessages(jid),
    api.getThreads(jid),
  ]);

  // Build the DB message list, then merge any SSE messages that arrived
  // during the fetch (they're already in messages.value via the SSE handler).
  const dbMessages = msgData.messages.map((m) => ({
    id: m.id,
    role: m.is_bot_message || m.is_from_me ? 'assistant' : 'user',
    content: m.content,
    timestamp: m.timestamp,
    senderName: m.sender_name,
  }));
  const dbIds = new Set(dbMessages.map((m) => m.id));
  const sseDuring = messages.value.filter((m) => !m.id || !dbIds.has(m.id));
  messages.value = [...dbMessages, ...sseDuring];

  // Index threads by their thread_id (= triggering message id)
  const meta = {};
  for (const t of threadData.threads) {
    meta[t.thread_id] = t;
  }
  threadMeta.value = meta;
  openThreads.value = {};
  threadTyping.value = {};
}

export async function handleSend(content) {
  if (!content.trim() || !selectedJid.value) return;

  // Optimistic update
  messages.value = [
    ...messages.value,
    { role: 'user', content, timestamp: new Date().toISOString() },
  ];

  try {
    await api.sendMessage(selectedJid.value, content);
  } catch (err) {
    messages.value = [
      ...messages.value,
      {
        role: 'assistant',
        content: `Error: ${err.message}`,
        timestamp: new Date().toISOString(),
        isError: true,
      },
    ];
  }
}

export async function createGroup(name, folder, template, opts = {}) {
  const result = await api.createGroup(name, folder, template, opts);
  await loadGroups();
  await loadTriggers();
  // Only auto-select standalone agents (triggered agents have no sidebar chat)
  if (!opts.triggerScope) {
    selectGroup(result.jid);
  }
  return result;
}

export async function toggleThread(threadId) {
  const threads = openThreads.value;
  if (threads[threadId]) {
    // Collapse — remove from open threads
    const next = { ...threads };
    delete next[threadId];
    openThreads.value = next;
    return;
  }
  // Expand — lazy-load messages on first open
  try {
    const data = await api.getThreadMessages(threadId);
    const mapped = data.messages.map((m) => ({
      id: m.id,
      role: m.is_bot_message || m.is_from_me ? 'assistant' : 'user',
      content: m.content,
      timestamp: m.timestamp,
      senderName: m.sender_name,
    }));
    openThreads.value = { ...openThreads.value, [threadId]: mapped };
  } catch (err) {
    console.error('Failed to load thread messages', err);
  }
}

export async function handleThreadReply(threadId, content) {
  if (!content.trim() || !selectedJid.value) return;

  // Optimistic update
  const threads = openThreads.value;
  if (threads[threadId]) {
    openThreads.value = {
      ...threads,
      [threadId]: [...threads[threadId], {
        role: 'user', content, timestamp: new Date().toISOString(),
      }],
    };
  }

  try {
    await api.sendMessage(selectedJid.value, content, undefined, threadId);
  } catch (err) {
    console.error('Failed to send thread reply', err);
  }
}

export async function loadTriggers() {
  try {
    const data = await api.getTriggers();
    triggers.value = data.triggers;
  } catch { /* ignore */ }
}

export async function clearChat(jid) {
  if (!jid) return;
  await api.clearMessages(jid);
  // Local state cleared by SSE messages_cleared handler
}

export async function deleteGroup(folder, jid) {
  await api.deleteGroup(folder);

  // Clear unread for deleted group
  const cur = { ...unread.value };
  delete cur[jid];
  unread.value = cur;

  // If the deleted group was selected, clear selection
  if (selectedJid.value === jid) {
    selectedJid.value = null;
    messages.value = [];
  }

  await loadGroups();
}

// --- Status/Task/Telemetry polling ---

async function pollStatus() {
  try {
    const data = await api.getStatus();
    status.value = data;

    // Clear stale typing for containers that have stopped.
    // Typing is SET only by SSE 'typing' events (actual generation),
    // not by container being active (it may be idle between messages).
    if (data?.containers?.groups) {
      const activeJids = new Set(
        data.containers.groups
          .filter((g) => g.active && !g.isTask)
          .map((g) => g.jid),
      );
      const newTyping = {};
      for (const [jid, val] of Object.entries(typingGroups.value)) {
        if (val && activeJids.has(jid)) {
          newTyping[jid] = true;
        }
        // If container is no longer active, typing gets dropped
      }
      typingGroups.value = newTyping;
    }
  } catch { /* ignore */ }
}

async function pollTasks() {
  try {
    const data = await api.getTasks();
    tasks.value = data.tasks;
  } catch { /* ignore */ }
}

async function pollTelemetry() {
  try {
    telemetry.value = await api.getTelemetry();
    // Telemetry-based achievements (centurion, streaks) are checked server-side
    // in the /api/telemetry handler and broadcast via SSE
  } catch { /* ignore */ }
}

async function pollUsage() {
  try {
    usage.value = await api.getUsage(24);
  } catch { /* ignore */ }
}

export async function pauseTask(taskId) {
  await api.pauseTask(taskId);
  await pollTasks();
}

export async function resumeTask(taskId) {
  await api.resumeTask(taskId);
  await pollTasks();
}

export async function cancelTask(taskId) {
  await api.cancelTask(taskId);
  await pollTasks();
}

export async function getTaskLogs(taskId) {
  return api.getTaskLogs(taskId);
}

// Start polling
pollStatus();
pollTasks();
pollTelemetry();
pollUsage();
loadAchievements();
setInterval(pollStatus, 5000);
setInterval(pollTasks, 10000);
setInterval(pollTelemetry, 30000);
setInterval(pollUsage, 30000);

// --- Theme ---

export const currentTheme = signal('dark');
export const customThemes = signal([]); // user-imported themes

function loadTheme() {
  // localStorage for instant restore (no flash)
  const saved = localStorage.getItem('clawdad-theme');
  const customJson = localStorage.getItem('clawdad-custom-themes');
  if (customJson) {
    try { customThemes.value = JSON.parse(customJson); } catch { /* ignore */ }
  }
  if (saved) {
    currentTheme.value = saved;
    const preset = getThemeByName(saved);
    if (preset) {
      applyTheme(preset.colors);
    } else {
      const custom = customThemes.value.find((t) => t.name === saved);
      if (custom) applyTheme(custom.colors);
    }
  }
}

export function setTheme(name) {
  const preset = getThemeByName(name);
  const custom = customThemes.value.find((t) => t.name === name);
  const theme = preset || custom;
  if (!theme) return;
  applyTheme(theme.colors);
  currentTheme.value = name;
  localStorage.setItem('clawdad-theme', name);
  // Also persist to config API (best-effort)
  api.saveConfig({ theme: name }).catch(() => {});
}

export function exportTheme() {
  const colors = getCurrentColors();
  const json = buildExportJson(currentTheme.value, colors);
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `clawdad-theme-${currentTheme.value}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function importTheme(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result);
        const error = validateThemeJson(json);
        if (error) return reject(new Error(error));
        const name = json.name || 'custom';
        const theme = { name, label: json.name || 'Custom', colors: json.colors };
        // Add to custom themes (replace if same name)
        const existing = customThemes.value.filter((t) => t.name !== name);
        customThemes.value = [...existing, theme];
        localStorage.setItem('clawdad-custom-themes', JSON.stringify(customThemes.value));
        applyTheme(theme.colors);
        currentTheme.value = name;
        localStorage.setItem('clawdad-theme', name);
        api.saveConfig({ theme: name }).catch(() => {});
        resolve(theme);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

export function removeCustomTheme(name) {
  // Never remove built-in presets
  if (getThemeByName(name)) return;
  customThemes.value = customThemes.value.filter((t) => t.name !== name);
  localStorage.setItem('clawdad-custom-themes', JSON.stringify(customThemes.value));
  // If the removed theme was active, fall back to dark
  if (currentTheme.value === name) setTheme('dark');
}

export function getAllThemes() {
  return [...THEMES, ...customThemes.value];
}

// Apply saved theme before render
loadTheme();

// --- Render ---

loadGroups();
loadTriggers();
render(html`<${App} />`, document.getElementById('app'));
