import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { groups, selectedJid, deleteGroup } from '../app.js';
import { GroupItem } from './GroupItem.js';
import { NewGroupDialog } from './NewGroupDialog.js';
import { StatusPanel } from './StatusPanel.js';

function DeleteConfirmDialog({ group, onClose }) {
  const [deleting, setDeleting] = useState(false);

  if (!group) return null;

  async function handleDelete() {
    setDeleting(true);
    try {
      // folder stored as web_<name>, strip prefix for API
      const apiFolder = group.folder.replace(/^web_/, '');
      await deleteGroup(apiFolder, group.jid);
      onClose();
    } catch (err) {
      console.error('Delete failed:', err);
      setDeleting(false);
    }
  }

  return html`
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick=${onClose}>
      <div class="bg-bg-2 border border-border rounded-xl p-6 w-[360px] shadow-xl" onClick=${(e) => e.stopPropagation()}>
        <h3 class="text-sm font-semibold text-txt mb-2">Delete "${group.name}"?</h3>
        <p class="text-xs text-txt-2 mb-4">
          This removes all messages, tasks, and agent data for this group. This cannot be undone.
        </p>
        <div class="flex justify-end gap-2">
          <button
            class="px-3 py-1.5 text-xs text-txt-2 hover:text-txt rounded-lg hover:bg-bg-hover transition-colors"
            onClick=${onClose}
            disabled=${deleting}
          >Cancel</button>
          <button
            class="px-3 py-1.5 text-xs font-semibold text-white bg-red-500 rounded-lg hover:bg-red-600 disabled:opacity-40 transition-colors"
            onClick=${handleDelete}
            disabled=${deleting}
          >${deleting ? 'Deleting...' : 'Delete'}</button>
        </div>
      </div>
    </div>
  `;
}

export function Sidebar() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  // Sort: template groups first, system groups at the bottom
  const list = [...groups.value].sort((a, b) => (a.isSystem ? 1 : 0) - (b.isSystem ? 1 : 0));
  const selected = selectedJid.value;

  return html`
    <aside class="w-[250px] min-w-[250px] bg-bg-2 border-r border-border flex flex-col">
      <div class="flex items-center justify-between px-4 py-3 border-b border-border">
        <div>
          <h1 class="text-base font-semibold text-txt leading-tight">ClawDad</h1>
          <p class="text-[10px] text-txt-muted leading-tight">NanoClaw Agent Orchestrator</p>
        </div>
        <button
          class="w-7 h-7 flex items-center justify-center rounded-md text-txt-2 hover:bg-bg-hover hover:text-txt transition-colors text-lg leading-none"
          title="New group"
          onClick=${() => setDialogOpen(true)}
        >
          +
        </button>
      </div>
      <div class="flex-1 overflow-y-auto py-1">
        ${list.length === 0
          ? html`
              <div class="px-4 py-3 text-xs text-txt-muted">
                No web groups yet. Click + to create one.
              </div>
            `
          : list.map(
              (g) => html`
                <${GroupItem}
                  key=${g.jid}
                  group=${g}
                  isActive=${g.jid === selected}
                  onDelete=${setDeleteTarget}
                />
              `,
            )}
      </div>
      <${StatusPanel} />
      <${NewGroupDialog} open=${dialogOpen} onClose=${() => setDialogOpen(false)} />
      <${DeleteConfirmDialog} key=${deleteTarget?.jid} group=${deleteTarget} onClose=${() => setDeleteTarget(null)} />
    </aside>
  `;
}
