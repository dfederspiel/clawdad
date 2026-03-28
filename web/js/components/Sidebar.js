import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { groups, selectedJid, selectGroup, deleteGroup, messages } from '../app.js';
import { GroupItem } from './GroupItem.js';
import { NewGroupDialog } from './NewGroupDialog.js';
import { StatusPanel } from './StatusPanel.js';
import { GameHud } from './GameHud.js';
import { ThemeMenu } from './ThemeMenu.js';
import { ConfirmDialog } from './ConfirmDialog.js';

export function Sidebar({ open, onClose }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  // Sort: template groups first, system groups at the bottom
  const list = [...groups.value].sort((a, b) => (a.isSystem ? 1 : 0) - (b.isSystem ? 1 : 0));
  const selected = selectedJid.value;

  function onGroupSelect(jid) {
    // Toggle: clicking the active group deselects it, showing the template picker
    if (jid === selected) {
      selectedJid.value = null;
      messages.value = [];
    } else {
      selectGroup(jid);
    }
    onClose();
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const apiFolder = deleteTarget.folder.replace(/^web_/, '');
      await deleteGroup(apiFolder, deleteTarget.jid);
      setDeleteTarget(null);
    } catch (err) {
      console.error('Delete failed:', err);
    } finally {
      setDeleting(false);
    }
  }

  return html`
    <!-- Backdrop (mobile only) -->
    ${open && html`
      <div
        class="fixed inset-0 bg-black/50 z-30 md:hidden"
        onClick=${onClose}
      />
    `}

    <!-- Sidebar -->
    <aside class="
      fixed inset-y-0 left-0 z-40 w-[280px]
      bg-bg-2 border-r border-border flex flex-col
      transform transition-transform duration-200 ease-out
      ${open ? 'translate-x-0' : '-translate-x-full'}
      md:static md:translate-x-0 md:w-[250px] md:min-w-[250px] md:z-auto
    ">
      <div class="flex items-center justify-between px-4 py-3 border-b border-border">
        <div>
          <h1 class="text-base font-semibold text-txt leading-tight">ClawDad</h1>
          <p class="text-[10px] text-txt-muted leading-tight">NanoClaw Agent Orchestrator</p>
        </div>
        <div class="flex items-center gap-1">
          <!-- Close button (mobile only) -->
          <button
            class="w-7 h-7 flex items-center justify-center rounded-md text-txt-2 hover:bg-bg-hover hover:text-txt transition-colors md:hidden"
            title="Close"
            onClick=${onClose}
          >
            <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
            </svg>
          </button>
          <div class="relative">
            <button
              class="w-7 h-7 flex items-center justify-center rounded-md text-txt-2 hover:bg-bg-hover hover:text-txt transition-colors"
              title="Theme"
              onClick=${(e) => { e.stopPropagation(); setThemeOpen(!themeOpen); }}
            >
              <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M4 2a2 2 0 00-2 2v11a3 3 0 106 0V4a2 2 0 00-2-2H4zm1 14a1 1 0 100-2 1 1 0 000 2zm5-1.757l4.9-4.9a2 2 0 000-2.828L13.485 5.1a2 2 0 00-2.828 0L10 5.757v8.486zM16 18H9.071l6-6H16a2 2 0 012 2v2a2 2 0 01-2 2z" clip-rule="evenodd"/>
              </svg>
            </button>
            <${ThemeMenu} open=${themeOpen} onClose=${() => setThemeOpen(false)} />
          </div>
          <button
            class="w-7 h-7 flex items-center justify-center rounded-md text-txt-2 hover:bg-bg-hover hover:text-txt transition-colors text-lg leading-none"
            title="New group"
            onClick=${() => setDialogOpen(true)}
          >
            +
          </button>
        </div>
      </div>
      <${GameHud} />
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
                  onSelect=${onGroupSelect}
                  onDelete=${setDeleteTarget}
                />
              `,
            )}
      </div>
      <${StatusPanel} />
      <${NewGroupDialog} open=${dialogOpen} onClose=${() => setDialogOpen(false)} />
    </aside>

    <!-- Delete confirmation rendered outside sidebar so it centers on the page -->
    <${ConfirmDialog}
      open=${!!deleteTarget}
      title=${`Delete "${deleteTarget?.name}"?`}
      message="This removes all messages, tasks, and agent data for this group. This cannot be undone."
      confirmLabel="Delete"
      confirmText=${deleteTarget?.name}
      destructive=${true}
      loading=${deleting}
      onConfirm=${handleDeleteConfirm}
      onCancel=${() => setDeleteTarget(null)}
    />
  `;
}
