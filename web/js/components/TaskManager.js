import { html } from 'htm/preact';
import { tasks, groups } from '../app.js';
import { TaskItem } from './TaskItem.js';

// Tasks for registered groups now live in an inline drawer on the group row
// (see GroupItem.js). This panel shows only "orphan" tasks — tasks whose
// group_folder no longer matches any registered web group — so they remain
// visible and manageable.
export function TaskManager() {
  const taskList = tasks.value;
  const groupList = groups.value;

  const knownFolders = new Set(groupList.map((g) => g.folder));
  const orphanTasks = taskList.filter(
    (t) => !t.group_folder || !knownFolders.has(t.group_folder),
  );

  if (taskList.length === 0) {
    return html`
      <div class="px-4 py-3 text-xs text-txt-muted">No scheduled tasks.</div>
    `;
  }

  if (orphanTasks.length === 0) {
    return html`
      <div class="px-4 py-3 text-xs text-txt-muted">
        All tasks are attached to a group — expand the task badge on a group to manage them.
      </div>
    `;
  }

  // Bucket orphans by folder so an unregistered folder with multiple tasks
  // still groups visually.
  const byFolder = {};
  for (const t of orphanTasks) {
    const key = t.group_folder || 'unknown';
    if (!byFolder[key]) byFolder[key] = [];
    byFolder[key].push(t);
  }

  return html`
    <div class="max-h-[400px] overflow-y-auto">
      <div class="px-3 py-1.5 text-[10px] text-txt-muted border-b border-border">
        Orphan tasks (no matching group)
      </div>
      ${Object.entries(byFolder).map(
        ([folder, folderTasks]) => {
          const active = folderTasks.filter((t) => t.status === 'active').length;
          const paused = folderTasks.filter((t) => t.status === 'paused').length;

          return html`
            <div class="border-b border-border last:border-b-0">
              <div class="flex items-center justify-between px-3 py-1.5 bg-bg">
                <span class="text-[10px] font-medium text-txt-muted uppercase tracking-wider">${folder}</span>
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
