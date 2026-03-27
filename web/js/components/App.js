import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { groups, selectedGroup } from '../app.js';
import { Sidebar } from './Sidebar.js';
import { ChatView } from './ChatView.js';
import { OnboardingGuide } from './OnboardingGuide.js';
import { NewGroupDialog } from './NewGroupDialog.js';

export function App() {
  const group = selectedGroup.value;
  const hasTemplateGroups = groups.value.some((g) => !g.isSystem);
  const [dialogOpen, setDialogOpen] = useState(false);

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
      ${html`<${Sidebar} />`}
      <main class="flex-1 flex flex-col min-w-0">
        ${group
          ? html`<${ChatView} />`
          : html`<div class="flex-1 flex items-center justify-center">
                <div class="text-center text-txt-2 px-6">
                  <p class="text-base mb-2">Select a group to start chatting.</p>
                </div>
              </div>`}
      </main>
      <${NewGroupDialog}
        open=${dialogOpen}
        onClose=${() => setDialogOpen(false)}
      />
    </div>
  `;
}
