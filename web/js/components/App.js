import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { groups, selectedGroup } from '../app.js';
import { Sidebar } from './Sidebar.js';
import { ChatView } from './ChatView.js';
import { OnboardingGuide } from './OnboardingGuide.js';
import { NewGroupDialog } from './NewGroupDialog.js';
import { AchievementToast } from './blocks/AchievementToast.js';
import { AchievementPanel } from './AchievementPanel.js';

export function App() {
  const group = selectedGroup.value;
  const hasTemplateGroups = groups.value.some((g) => !g.isSystem);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Show full-width onboarding when no template groups exist yet
  if (!hasTemplateGroups) {
    return html`
      <div class="flex h-full">
        <main class="flex-1 flex flex-col min-w-0">
          <${OnboardingGuide} onCustom=${() => setDialogOpen(true)} />
        </main>
        <${NewGroupDialog}
          open=${dialogOpen}
          onClose=${() => setDialogOpen(false)}
        />
      </div>
    `;
  }

  return html`
    <div class="flex h-full">
      ${html`<${Sidebar} open=${sidebarOpen} onClose=${() => setSidebarOpen(false)} />`}
      <main class="flex-1 flex flex-col min-w-0">
        ${group
          ? html`<${ChatView} onOpenSidebar=${() => setSidebarOpen(true)} />`
          : html`<${OnboardingGuide} onCustom=${() => setDialogOpen(true)} compact=${true} />`}
      </main>
      <${NewGroupDialog}
        open=${dialogOpen}
        onClose=${() => setDialogOpen(false)}
      />
      <${AchievementToast} />
      <${AchievementPanel} />
    </div>
  `;
}
