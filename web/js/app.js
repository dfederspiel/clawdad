import { render } from 'preact';
import { signal, computed } from 'preact/signals';
import { html } from 'htm/preact';
import * as api from './api.js';
import { App } from './components/App.js';

// --- Global State (signals) ---

export const groups = signal([]);
export const selectedJid = signal(null);
export const messages = signal([]);
export const typingGroups = signal({}); // { [jid]: boolean }
export const typing = computed(() => typingGroups.value[selectedJid.value] || false);
export const unread = signal({}); // { [jid]: count }

export const selectedGroup = computed(() =>
  groups.value.find((g) => g.jid === selectedJid.value) || null,
);

// Status, tasks, and telemetry (polled)
export const status = signal(null);
export const tasks = signal([]);
export const telemetry = signal(null);

// --- SSE ---

const clientId = crypto.randomUUID();
api.connectSSE(clientId);

api.onSSE('message', (data) => {
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
  typingGroups.value = { ...typingGroups.value, [data.jid]: data.isTyping };
});

api.onSSE('user_message', () => {
  // Ignore echo — optimistic update already shows the message
});

// --- Actions ---

export async function loadGroups() {
  const data = await api.getGroups();
  groups.value = data.groups;

  // Auto-select main group (or first) if nothing is selected
  if (!selectedJid.value && data.groups.length > 0) {
    const main = data.groups.find((g) => g.isMain);
    selectGroup(main ? main.jid : data.groups[0].jid);
  }
}

export async function selectGroup(jid) {
  selectedJid.value = jid;

  // Clear unread for this group
  const cur = { ...unread.value };
  delete cur[jid];
  unread.value = cur;

  const data = await api.getMessages(jid);
  messages.value = data.messages.map((m) => ({
    role: m.is_bot_message || m.is_from_me ? 'assistant' : 'user',
    content: m.content,
    timestamp: m.timestamp,
    senderName: m.sender_name,
  }));
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

export async function createGroup(name, folder, template) {
  const result = await api.createGroup(name, folder, template);
  await loadGroups();
  selectGroup(result.jid);
  return result;
}

// --- Status/Task/Telemetry polling ---

async function pollStatus() {
  try {
    const data = await api.getStatus();
    status.value = data;

    // Sync typing state with active containers — handles page reload
    // AND clears stale typing for containers that have stopped
    if (data?.containers?.groups) {
      const activeJids = new Set(
        data.containers.groups
          .filter((g) => g.active && !g.isTask)
          .map((g) => g.jid),
      );
      const newTyping = {};
      // Set typing for active containers
      for (const jid of activeJids) {
        newTyping[jid] = true;
      }
      // Preserve SSE-driven typing only if container is still active
      for (const [jid, val] of Object.entries(typingGroups.value)) {
        if (val && activeJids.has(jid)) {
          newTyping[jid] = true;
        }
        // If container is no longer active, typing gets dropped (not carried over)
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
setInterval(pollStatus, 5000);
setInterval(pollTasks, 10000);
setInterval(pollTelemetry, 30000);

// --- Render ---

loadGroups();
render(html`<${App} />`, document.getElementById('app'));
