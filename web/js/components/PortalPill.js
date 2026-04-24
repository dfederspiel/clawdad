import { html } from 'htm/preact';
import { agentPanel, portalThreads, selectedGroup } from '../app.js';

export function openPortalInDrawer(threadId) {
  const group = selectedGroup.value;
  if (!group) return;
  const portal = portalThreads.value[threadId];
  // Live portals open in the "portals" stack (focused on the clicked one);
  // historical portals open solo in a single-portal view.
  if (portal?.live) {
    agentPanel.value = {
      mode: 'portals',
      groupFolder: group.folder,
      focusedThreadId: threadId,
    };
  } else {
    agentPanel.value = {
      mode: 'portal-single',
      groupFolder: group.folder,
      threadId,
    };
  }
}

export function PortalPill({ threadId }) {
  const portal = portalThreads.value[threadId];
  if (!portal) return null;

  const count = portal.messages.length || portal.replyCount || 0;
  const subtitle = portal.sourceAgent
    ? `delegated by ${portal.sourceAgent}`
    : count
      ? `${count} message${count !== 1 ? 's' : ''}`
      : 'running...';

  return html`
    <button
      class="self-start flex items-center gap-2 px-3 py-1.5 rounded-full bg-bg-3 border border-border text-[11px] text-txt-2 hover:border-accent hover:text-accent transition-colors cursor-pointer max-w-[85%]"
      onClick=${() => openPortalInDrawer(threadId)}
      title="Open portal"
    >
      <span class="text-accent">\u2197</span>
      <span class="font-medium truncate">${portal.agentName || 'Agent'}'s portal</span>
      <span class="text-txt-muted truncate">· ${subtitle}</span>
    </button>
  `;
}
