import { html } from 'htm/preact';
import { tasks } from '../app.js';
import { TaskItem } from './TaskItem.js';

export function TaskManager() {
  const taskList = tasks.value;

  if (taskList.length === 0) {
    return html`
      <div class="px-4 py-3 text-xs text-txt-muted">No scheduled tasks.</div>
    `;
  }

  // Group by group_folder
  const byGroup = {};
  for (const t of taskList) {
    const key = t.group_folder || 'unknown';
    if (!byGroup[key]) byGroup[key] = [];
    byGroup[key].push(t);
  }

  return html`
    <div class="max-h-[300px] overflow-y-auto">
      ${Object.entries(byGroup).map(
        ([folder, folderTasks]) => html`
          <div class="border-b border-border/30 last:border-b-0">
            <div class="px-4 py-1.5 text-[10px] font-medium text-txt-muted uppercase tracking-wider bg-bg/50">
              ${folder}
            </div>
            ${folderTasks.map((t) => html`<${TaskItem} key=${t.id} task=${t} />`)}
          </div>
        `,
      )}
    </div>
  `;
}
