import { html } from 'htm/preact';
import { useState, useEffect, useRef } from 'preact/hooks';

/**
 * Reusable confirmation dialog.
 *
 * Uses the native <dialog> element with showModal() so the modal is
 * rendered in the browser's top layer — this is required to escape
 * transform/filter ancestors (e.g. the sidebar <aside>) that would
 * otherwise contain `position: fixed` children and leave the dialog
 * squished inside the sidebar column.
 *
 * Props:
 *   open        - boolean, controls visibility
 *   title       - dialog heading
 *   message     - description text
 *   confirmLabel - button text (default "Confirm")
 *   confirmText - if set, user must type this string to enable the confirm button
 *   destructive - if true, confirm button is red (default false)
 *   loading     - if true, shows loading state and disables buttons
 *   onConfirm   - called when confirmed
 *   onCancel    - called when cancelled
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  confirmText,
  destructive = false,
  loading = false,
  onConfirm,
  onCancel,
}) {
  const [typed, setTyped] = useState('');
  const dialogRef = useRef(null);
  const inputRef = useRef(null);

  // Sync open prop → native dialog open state via showModal/close
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      dlg.showModal();
      setTyped('');
      if (confirmText) {
        setTimeout(() => inputRef.current?.focus(), 50);
      }
    } else if (!open && dlg.open) {
      dlg.close();
    }
  }, [open, confirmText]);

  // Native dialog's ESC triggers a 'cancel' event — forward it
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    const handleCancel = (e) => {
      e.preventDefault();
      if (!loading) onCancel?.();
    };
    dlg.addEventListener('cancel', handleCancel);
    return () => dlg.removeEventListener('cancel', handleCancel);
  }, [loading, onCancel]);

  const canConfirm = confirmText ? typed === confirmText : true;

  const confirmBtnClass = destructive
    ? 'px-3 py-1.5 text-xs font-semibold text-white bg-red-500 rounded-lg hover:bg-red-600 disabled:opacity-40 transition-colors'
    : 'px-3 py-1.5 text-xs font-semibold text-white bg-accent rounded-lg hover:opacity-90 disabled:opacity-40 transition-colors';

  // Click on the dialog's own backdrop (not the inner panel) cancels.
  // e.target === dialog means the click was on the backdrop area.
  function handleBackdropClick(e) {
    if (e.target === dialogRef.current && !loading) onCancel?.();
  }

  return html`
    <dialog
      ref=${dialogRef}
      class="bg-bg-2 text-txt border border-border rounded-xl p-6 w-[360px] shadow-xl backdrop:bg-black/50"
      onClick=${handleBackdropClick}
    >
      <h3 class="text-sm font-semibold text-txt mb-2">${title}</h3>
      <p class="text-xs text-txt-2 mb-4">${message}</p>
      ${confirmText && html`
        <div class="mb-4">
          <p class="text-xs text-txt-2 mb-2">
            Type <span class="font-mono font-semibold text-txt">${confirmText}</span> to confirm:
          </p>
          <input
            ref=${inputRef}
            type="text"
            class="w-full px-3 py-1.5 text-xs bg-bg border border-border rounded-lg text-txt focus:outline-none focus:border-accent"
            value=${typed}
            onInput=${(e) => setTyped(e.target.value)}
            placeholder=${confirmText}
            disabled=${loading}
            autocomplete="off"
            spellcheck="false"
          />
        </div>
      `}
      <div class="flex justify-end gap-2">
        <button
          class="px-3 py-1.5 text-xs text-txt-2 hover:text-txt rounded-lg hover:bg-bg-hover transition-colors"
          onClick=${onCancel}
          disabled=${loading}
        >Cancel</button>
        <button
          class=${confirmBtnClass}
          onClick=${onConfirm}
          disabled=${loading || !canConfirm}
        >${loading ? 'Working...' : confirmLabel}</button>
      </div>
    </dialog>
  `;
}
