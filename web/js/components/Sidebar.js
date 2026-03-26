import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { groups, selectedJid } from '../app.js';
import { GroupItem } from './GroupItem.js';
import { NewGroupDialog } from './NewGroupDialog.js';
import { StatusPanel } from './StatusPanel.js';

export function Sidebar() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const list = groups.value;
  const selected = selectedJid.value;

  return html`
    <aside class="w-[250px] min-w-[250px] bg-bg-2 border-r border-border flex flex-col">
      <div class="flex items-center justify-between px-4 py-3 border-b border-border">
        <h1 class="text-base font-semibold text-txt">NanoClaw</h1>
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
                />
              `,
            )}
      </div>
      <${StatusPanel} />
      <${NewGroupDialog} open=${dialogOpen} onClose=${() => setDialogOpen(false)} />
    </aside>
  `;
}
