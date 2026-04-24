// Per-jid portal panel state persistence.
//
// What we store, keyed by chat jid:
//   - liveThreadIds: portals currently "in the stack" for this chat
//   - drawer: { mode, focusedThreadId?, threadId? } or null when closed
//
// What this buys:
//   - Refresh restores the drawer and its stack
//   - Switching groups remembers each group's panel state independently
//   - Closing the drawer hides it but keeps live flags (out of sight, not
//     out of mind). Explicit dismiss (section X) removes from live.

const KEY = 'clawdad-portal-panel-state';

function readAll() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* quota / private mode — silently degrade */
  }
}

export function loadPortalStateFor(jid) {
  if (!jid) return { liveThreadIds: [], drawer: null };
  const all = readAll();
  const entry = all[jid] || {};
  return {
    liveThreadIds: Array.isArray(entry.liveThreadIds) ? entry.liveThreadIds : [],
    drawer: entry.drawer || null,
  };
}

export function savePortalStateFor(jid, patch) {
  if (!jid) return;
  const all = readAll();
  const current = all[jid] || { liveThreadIds: [], drawer: null };
  all[jid] = { ...current, ...patch };
  writeAll(all);
}

export function addLiveThreadForJid(jid, threadId) {
  if (!jid || !threadId) return;
  const { liveThreadIds } = loadPortalStateFor(jid);
  if (liveThreadIds.includes(threadId)) return;
  savePortalStateFor(jid, { liveThreadIds: [...liveThreadIds, threadId] });
}

export function removeLiveThreadForJid(jid, threadId) {
  if (!jid || !threadId) return;
  const { liveThreadIds } = loadPortalStateFor(jid);
  if (!liveThreadIds.includes(threadId)) return;
  savePortalStateFor(jid, {
    liveThreadIds: liveThreadIds.filter((t) => t !== threadId),
  });
}

export function setDrawerStateFor(jid, drawer) {
  if (!jid) return;
  savePortalStateFor(jid, { drawer: drawer || null });
}
