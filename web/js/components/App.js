import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { groups, selectedGroup } from '../app.js';
import { Sidebar } from './Sidebar.js';
import { ChatView } from './ChatView.js';
import { OnboardingGuide } from './OnboardingGuide.js';
import { NewGroupDialog } from './NewGroupDialog.js';

export function App() {
  const group = selectedGroup.value;
  const hasGroups = groups.value.length > 0;
  const [dialogOpen, setDialogOpen] = useState(false);

  return html`
    <div class="flex h-full">
      ${hasGroups && html`<${Sidebar} />`}
      <main class="flex-1 flex flex-col min-w-0">
        ${group
          ? html`<${ChatView} />`
          : hasGroups
            ? html`<div class="flex-1 flex items-center justify-center">
                <div class="text-center text-txt-2 px-6">
                  <p class="text-base mb-2">Select a group to start chatting.</p>
                </div>
              </div>`
            : html`<${OnboardingGuide} onCustom=${() => setDialogOpen(true)} />`}
      </main>
      <${NewGroupDialog}
        open=${dialogOpen}
        onClose=${() => setDialogOpen(false)}
      />
    </div>
  `;
}
