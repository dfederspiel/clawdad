import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { agentPanel, portalThreads, portalProgress, selectedJid } from '../app.js';
import * as api from '../api.js';
import { MessageBody } from './MessageBody.js';

function formatTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return '';
  }
}

function formatDuration(ms) {
  if (!ms) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function formatCost(usd) {
  if (!usd) return '';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function ThinkingEntry({ entry }) {
  const [open, setOpen] = useState(false);
  return html`
    <div class="py-1 px-2 border-l-2 border-txt-muted/30 opacity-70">
      <button
        class="text-[10px] text-txt-muted font-mono hover:text-txt-2 transition-colors flex items-center gap-1.5 cursor-pointer"
        onClick=${() => setOpen(!open)}
        title="Agent internal reasoning"
      >
        <span class="text-[9px] transition-transform ${open ? 'rotate-90' : ''}">\u25B6</span>
        <span>thinking</span>
      </button>
      ${open && html`
        <div class="mt-1 text-[11px] text-txt-muted italic whitespace-pre-wrap break-words">
          ${entry.content}
        </div>
      `}
    </div>
  `;
}

function Entry({ entry }) {
  if (entry.type === 'thinking') {
    return html`<${ThinkingEntry} entry=${entry} />`;
  }
  if (entry.type === 'text') {
    const isUser = entry.role === 'user';
    return html`
      <div class="flex flex-col gap-1 py-2 px-3 rounded-md ${isUser ? 'bg-userbg' : 'bg-asstbg'}">
        <div class="text-[10px] text-txt-muted font-mono">
          ${isUser ? 'user' : 'assistant'} · ${formatTime(entry.timestamp)}
        </div>
        <div class="text-xs text-txt-2 whitespace-pre-wrap break-words">${entry.content}</div>
      </div>
    `;
  }
  if (entry.type === 'tool_use') {
    return html`
      <div class="flex items-start gap-2 py-1.5 px-2 border-l-2 border-accent/50">
        <span class="font-mono text-[10px] text-accent shrink-0 mt-0.5">${entry.tool}</span>
        <span class="text-xs text-txt-2 font-mono break-words">${entry.summary || ''}</span>
      </div>
    `;
  }
  if (entry.type === 'tool_result') {
    if (!entry.content) return null;
    return html`
      <div class="pl-4 text-[11px] text-txt-muted font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
        ${entry.content}
      </div>
    `;
  }
  return null;
}

function LiveMessage({ msg }) {
  const isUser = msg.role === 'user';
  // shrink-0: inside a flex-col scroll container, children default to
  // flex-shrink:1 which collapses them to fit the container's max-height
  // instead of overflowing — so nothing scrolls. shrink-0 keeps each
  // message at its natural size; the parent's overflow-y handles it.
  return html`
    <div class="shrink-0 flex flex-col gap-1 py-2 px-3 rounded-md break-words ${isUser ? 'bg-userbg' : 'bg-asstbg'}">
      <div class="text-[10px] text-txt-muted font-mono">
        ${msg.senderName || (isUser ? 'user' : 'assistant')} · ${formatTime(msg.timestamp)}
      </div>
      <div class="text-xs leading-relaxed">
        <${MessageBody} content=${msg.content} />
      </div>
    </div>
  `;
}

const STALL_THRESHOLD_MS = 30000;

/** Renders one portal (specialist) as a collapsible section in the stack.
 *  isRunning drives the LIVE badge; sections stay in the stack after the
 *  agent finishes so the user can keep reading. */
function PortalSection({ threadId, portal, focused, isRunning }) {
  const sectionRef = useRef(null);
  const [historicalMsgs, setHistoricalMsgs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let cancelled = false;
    api
      .getThreadMessages(threadId)
      .then((resp) => {
        if (cancelled) return;
        const msgs = (resp?.messages || []).map((m) => ({
          id: m.id,
          role: m.is_bot_message || m.is_from_me ? 'assistant' : 'user',
          content: m.content,
          timestamp: m.timestamp,
          senderName: m.sender_name,
        }));
        setHistoricalMsgs(msgs);
        setLoading(false);
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [threadId]);

  useEffect(() => {
    if (focused && sectionRef.current) {
      sectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setOpen(true);
    }
  }, [focused]);

  // Tick every 2s while running so stall detection can re-render without
  // waiting for the next progress event.
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(id);
  }, [isRunning]);

  const liveMsgs = portal?.messages || [];
  const seen = new Set(historicalMsgs.map((m) => m.id).filter(Boolean));
  const combined = [
    ...historicalMsgs,
    ...liveMsgs.filter((m) => !m.id || !seen.has(m.id)),
  ];
  const count = combined.length;

  // Per-portal progress feed — shows the agent's tool-call chain live.
  const progress = portalProgress.value[threadId];
  const lastEventAt = progress?.lastEventAt || 0;
  const recentTool = progress?.history?.filter((h) => h.tool && h.tool !== 'text').slice(-1)[0];
  const stalled =
    isRunning && lastEventAt > 0 && now - lastEventAt > STALL_THRESHOLD_MS;

  const dismiss = (e) => {
    e.stopPropagation();
    const next = { ...portalThreads.value };
    delete next[threadId];
    portalThreads.value = next;
  };

  return html`
    <section
      ref=${sectionRef}
      class="flex flex-col border border-border rounded-md overflow-hidden ${focused ? 'ring-1 ring-accent/60' : ''}"
    >
      <div
        class="flex items-center gap-2 px-3 py-2 bg-bg-3 hover:bg-bg-hover transition-colors cursor-pointer"
        onClick=${() => setOpen(!open)}
      >
        <span class="text-[9px] transition-transform ${open ? 'rotate-90' : ''}">\u25B6</span>
        <span class="text-xs font-semibold truncate">
          ${portal.agentName || 'Agent'}${portal.title ? html`<span class="font-normal text-txt-2"> \u2014 ${portal.title}</span>` : ''}
        </span>
        ${isRunning && !stalled && html`
          <span class="text-[9px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded bg-accent/20 text-accent">live</span>
        `}
        ${stalled && html`
          <span class="text-[9px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded bg-err/20 text-err" title="No activity for ${Math.round((now - lastEventAt) / 1000)}s">stalled?</span>
        `}
        <span class="text-[10px] text-txt-muted font-mono ml-auto shrink-0">
          ${count} msg${count !== 1 ? 's' : ''}
        </span>
        <button
          class="w-5 h-5 flex items-center justify-center rounded text-txt-muted hover:text-err hover:bg-bg-2 transition-colors shrink-0"
          title="Remove from stack"
          onClick=${dismiss}
        >
          <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
          </svg>
        </button>
      </div>
      ${open && html`
        <div class="portal-scroll p-2 flex flex-col gap-1.5 bg-bg-2" style="min-height: 4rem; max-height: 40rem; overflow-y: scroll;">
          ${loading && combined.length === 0 && html`
            <div class="text-xs text-txt-muted p-2 text-center">Loading...</div>
          `}
          ${!loading && combined.length === 0 && !isRunning && html`
            <div class="text-xs text-txt-muted p-2 text-center">No messages.</div>
          `}
          ${combined.map((m, i) => html`<${LiveMessage} key=${m.id || i} msg=${m} />`)}
          ${isRunning && recentTool && html`
            <div class="flex items-start gap-2 py-1 px-2 text-[11px] text-txt-muted">
              <span class="font-mono text-[10px] text-accent shrink-0 mt-px">${recentTool.tool}</span>
              <span class="truncate">${recentTool.summary || ''}</span>
              <span class="typing-dot inline-block ml-auto mt-1" />
            </div>
          `}
          ${isRunning && !recentTool && combined.length === 0 && html`
            <div class="text-xs text-txt-muted p-2 text-center">
              Waiting for agent output... <span class="typing-dot inline-block ml-1" />
            </div>
          `}
        </div>
      `}
    </section>
  `;
}

function PortalsPanel({ state }) {
  const portals = portalThreads.value;
  const jid = selectedJid.value;
  // Only show live (this-session) portals in the drawer stack. Historical
  // portals are reachable via pills in the main feed — clicking a pill
  // opens the single-portal view (PortalSinglePanel).
  const entries = Object.entries(portals)
    .filter(([, p]) => p.jid === jid && p.live)
    .sort((a, b) => (b[1].openedAt || 0) - (a[1].openedAt || 0)); // newest first

  return html`
    <div class="flex flex-col h-full min-h-0">
      <header class="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div class="flex flex-col gap-0.5 min-w-0">
          <h3 class="text-sm font-semibold truncate">
            ${entries.length > 1 ? `${entries.length} live portals` : 'Agent portal'}
          </h3>
          <div class="text-[11px] text-txt-muted font-mono truncate">
            side work · click header to collapse
          </div>
        </div>
        <${CloseButton} />
      </header>
      <div class="portal-scroll flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2">
        ${entries.length === 0 && html`
          <div class="text-xs text-txt-muted p-4 text-center">
            No active portals. Click a portal pill in the chat to view a past session.
          </div>
        `}
        ${entries.map(([threadId, portal]) => html`
          <${PortalSection}
            key=${threadId}
            threadId=${threadId}
            portal=${portal}
            focused=${state.focusedThreadId === threadId}
            isRunning=${!!portal.running}
          />
        `)}
      </div>
    </div>
  `;
}

function PortalSinglePanel({ state }) {
  const portals = portalThreads.value;
  const portal = portals[state.threadId];
  return html`
    <div class="flex flex-col h-full min-h-0">
      <header class="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div class="flex flex-col gap-0.5 min-w-0">
          <h3 class="text-sm font-semibold truncate">
            ${portal?.agentName || 'Agent'}'s portal
          </h3>
          <div class="text-[11px] text-txt-muted font-mono truncate">
            ${portal?.createdAt ? formatTime(portal.createdAt) : ''}
            ${portal?.sourceAgent ? ` · delegated by ${portal.sourceAgent}` : ''}
          </div>
        </div>
        <${CloseButton} />
      </header>
      <div class="portal-scroll flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2">
        ${portal
          ? html`<${PortalSection}
              threadId=${state.threadId}
              portal=${portal}
              focused=${true}
              isRunning=${!!portal.running}
            />`
          : html`<div class="text-xs text-txt-muted p-4 text-center">Portal not found.</div>`}
      </div>
    </div>
  `;
}

function RetroactivePanel({ state }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const { runId, groupFolder } = state;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getTranscript(groupFolder, runId)
      .then((resp) => {
        if (cancelled) return;
        setData(resp);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || 'Failed to load transcript');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [state.runId, state.groupFolder]);

  const run = data?.run;
  const timeline = data?.timeline || [];

  return html`
    <div class="flex flex-col h-full min-h-0">
      <header class="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div class="flex flex-col gap-0.5 min-w-0">
          <h3 class="text-sm font-semibold truncate">Agent conversation</h3>
          ${run && html`
            <div class="text-[11px] text-txt-muted font-mono truncate">
              ${formatTime(run.timestamp)}
              ${run.duration_ms ? ` · ${formatDuration(run.duration_ms)}` : ''}
              ${run.num_turns ? ` · ${run.num_turns} turn${run.num_turns !== 1 ? 's' : ''}` : ''}
              ${run.cost_usd ? ` · ${formatCost(run.cost_usd)}` : ''}
            </div>
          `}
        </div>
        <${CloseButton} />
      </header>
      <div class="portal-scroll flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-1.5">
        ${loading && html`<div class="text-xs text-txt-muted p-4 text-center">Loading transcript...</div>`}
        ${error && html`
          <div class="text-xs text-err p-4 text-center">
            ${error}
            ${state.runId == null && html`
              <div class="text-txt-muted mt-2">No run ID recorded for this message. Older messages may not have this data.</div>
            `}
          </div>
        `}
        ${!loading && !error && timeline.length === 0 && html`
          <div class="text-xs text-txt-muted p-4 text-center">No transcript entries in this run window.</div>
        `}
        ${timeline.map((entry, i) => html`<${Entry} key=${i} entry=${entry} />`)}
      </div>
    </div>
  `;
}

function closeDrawer() {
  // Closing the drawer clears the "live" flag on all portals — they stay
  // in portalThreads for pill recall but drop out of the stack. The next
  // time the user opens the drawer (via pill click or new thread_opened),
  // the stack starts fresh.
  const portals = portalThreads.value;
  const cleared = {};
  for (const [tid, p] of Object.entries(portals)) {
    cleared[tid] = p.live ? { ...p, live: false, running: false } : p;
  }
  portalThreads.value = cleared;
  agentPanel.value = null;
}

function CloseButton() {
  return html`
    <button
      class="w-7 h-7 flex items-center justify-center rounded-md text-txt-2 hover:bg-bg-hover hover:text-txt transition-colors shrink-0 ml-2"
      title="Close"
      onClick=${closeDrawer}
    >
      <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
      </svg>
    </button>
  `;
}

export function AgentPanel() {
  const state = agentPanel.value;

  useEffect(() => {
    if (!state) return;
    const onKey = (e) => {
      if (e.key === 'Escape') closeDrawer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state]);

  if (!state) return null;

  const close = closeDrawer;

  let body;
  if (state.mode === 'portals') {
    body = html`<${PortalsPanel} state=${state} />`;
  } else if (state.mode === 'portal-single') {
    body = html`<${PortalSinglePanel} state=${state} />`;
  } else {
    body = html`<${RetroactivePanel} state=${state} />`;
  }

  return html`
    <div class="fixed inset-0 z-40 bg-black/40 md:hidden" onClick=${close} />
    <aside
      style="height: 100vh; max-height: 100vh;"
      class="fixed top-0 right-0 w-full z-50 bg-bg-2 border-l border-border shadow-xl flex flex-col
             md:static md:z-auto md:shadow-none md:w-[440px] lg:w-[520px] md:shrink-0"
    >
      ${body}
    </aside>
  `;
}

export function openAgentPanel(runId, groupFolder) {
  agentPanel.value = { runId, groupFolder };
}
