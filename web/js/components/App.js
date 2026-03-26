import { html } from 'htm/preact';
import { selectedGroup } from '../app.js';
import { Sidebar } from './Sidebar.js';
import { ChatView } from './ChatView.js';
import { EmptyState } from './EmptyState.js';

export function App() {
  const group = selectedGroup.value;

  return html`
    <div class="flex h-full">
      <${Sidebar} />
      <main class="flex-1 flex flex-col min-w-0">
        ${group
          ? html`<${ChatView} />`
          : html`<${EmptyState}
              message="Create a group to start chatting with an agent."
              hint="Each group runs an isolated Claude agent with its own memory and context."
            />`}
      </main>
    </div>
  `;
}
