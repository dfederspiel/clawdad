import { html } from 'htm/preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { createGroup } from '../app.js';

export function NewGroupDialog({ open, onClose }) {
  const dialogRef = useRef(null);
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [manual, setManual] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open && dialogRef.current && !dialogRef.current.open) {
      dialogRef.current.showModal();
    } else if (!open && dialogRef.current?.open) {
      dialogRef.current.close();
    }
  }, [open]);

  function onNameInput(e) {
    const val = e.target.value;
    setName(val);
    if (!manual) {
      setFolder(
        val
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'group',
      );
    }
  }

  function onFolderInput(e) {
    setManual(true);
    setFolder(e.target.value);
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (!name.trim() || !folder.trim() || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await createGroup(name.trim(), folder.trim());
      setName('');
      setFolder('');
      setManual(false);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return html`
    <dialog
      ref=${dialogRef}
      class="bg-bg-2 text-txt border border-border rounded-xl p-0 backdrop:bg-black/60 max-w-md w-full"
      onClose=${onClose}
    >
      <form onSubmit=${onSubmit} class="p-6 flex flex-col gap-4">
        <h2 class="text-lg font-semibold">New Agent Group</h2>

        <label class="flex flex-col gap-1.5">
          <span class="text-sm text-txt-2">Name</span>
          <input
            type="text"
            class="bg-bg-3 border border-border rounded-lg px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent"
            placeholder="e.g. Code Review"
            value=${name}
            onInput=${onNameInput}
            required
          />
        </label>

        <label class="flex flex-col gap-1.5">
          <span class="text-sm text-txt-2">Folder ID</span>
          <input
            type="text"
            class="bg-bg-3 border border-border rounded-lg px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent"
            placeholder="e.g. code-review"
            pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
            value=${folder}
            onInput=${onFolderInput}
            required
          />
          <span class="text-xs text-txt-muted">
            Alphanumeric, dashes, underscores. Used for the agent's workspace folder.
          </span>
        </label>

        ${error && html`<p class="text-sm text-err">${error}</p>`}

        <div class="flex justify-end gap-3 mt-2">
          <button
            type="button"
            class="px-4 py-2 text-sm text-txt-2 hover:text-txt transition-colors"
            onClick=${onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            class="px-4 py-2 bg-accent text-bg font-semibold rounded-lg text-sm hover:brightness-110 disabled:opacity-40 transition-all"
            disabled=${!name.trim() || !folder.trim() || submitting}
          >
            ${submitting ? 'Creating...' : 'Create'}
          </button>
        </div>
      </form>
    </dialog>
  `;
}
