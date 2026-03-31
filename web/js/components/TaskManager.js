import { html } from 'htm/preact';
import { tasks, groups } from '../app.js';
import { TaskItem } from './TaskItem.js';

export function TaskManager() {
  const taskList = tasks.value;
  const groupList = groups.value;

  if (taskList.length === 0) {
    return html`
      <div class="px-4 py-3 text-xs text-txt-muted">No scheduled tasks.</div>
    `;
  }

  // Group by group_folder, with friendly names from groups list
  const byGroup = {};
  for (const t of taskList) {
    const key = t.group_folder || 'unknown';
    if (!byGroup[key]) byGroup[key] = [];
    byGroup[key].push(t);
  }

  // Map folder to display name
  const folderNames = {};
  for (const g of groupList) {
    folderNames[g.folder] = g.name;
  }

  return html`
    <div class="max-h-[400px] overflow-y-auto">
      ${Object.entries(byGroup).map(
        ([folder, folderTasks]) => {
          const active = folderTasks.filter(t => t.status === 'active').length;
          const paused = folderTasks.filter(t => t.status === 'paused').length;
          const displayName = folderNames[folder] || folder;

          return html`
            <div class="border-b border-border last:border-b-0">
              <div class="flex items-center justify-between px-3 py-1.5 bg-bg">
                <span class="text-[10px] font-medium text-txt-muted uppercase tracking-wider">${displayName}</span>
                <span class="text-[10px] text-txt-muted font-mono">
                  ${active}${paused > 0 ? `/${paused}p` : ''}
                </span>
              </div>
              ${folderTasks.map((t) => html`<${TaskItem} key=${t.id} task=${t} />`)}
            </div>
          `;
        },
      )}
    </div>
  `;
}
