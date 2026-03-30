import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { groups, selectedGroup } from '../app.js';
import { Sidebar } from './Sidebar.js';
import { ChatView } from './ChatView.js';
import { OnboardingGuide } from './OnboardingGuide.js';
import { NewGroupDialog } from './NewGroupDialog.js';
import { AchievementToast } from './blocks/AchievementToast.js';
import { AchievementPanel } from './AchievementPanel.js';
import { CredentialModal } from './CredentialModal.js';

export function App() {
  const group = selectedGroup.value;
  const hasTemplateGroups = groups.value.some((g) => !g.isSystem);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [customDialogOpen, setCustomDialogOpen] = useState(false);

  // Show full-width onboarding when no template groups exist yet
  if (!hasTemplateGroups) {
    return html`
      <div class="flex h-full">
        <main class="flex-1 flex flex-col min-w-0">
          <${OnboardingGuide} onCustom=${() => setCustomDialogOpen(true)} />
        </main>
        <${NewGroupDialog} open=${customDialogOpen} onClose=${() => setCustomDialogOpen(false)} initialView="custom" />
        <${CredentialModal} />
      </div>
    `;
  }

  return html`
    <div class="flex h-full">
      ${html`<${Sidebar} open=${sidebarOpen} onClose=${() => setSidebarOpen(false)} />`}
      <main class="flex-1 flex flex-col min-w-0">
        ${group
          ? html`<${ChatView} onOpenSidebar=${() => setSidebarOpen(true)} />`
          : html`<${OnboardingGuide} compact=${true} onCustom=${() => setCustomDialogOpen(true)} />`}
      </main>
      <${NewGroupDialog} open=${customDialogOpen} onClose=${() => setCustomDialogOpen(false)} initialView="custom" />
      <${AchievementToast} />
      <${AchievementPanel} />
      <${CredentialModal} />
    </div>
  `;
}
