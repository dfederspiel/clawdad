import { html } from 'htm/preact';
import { useState, useRef } from 'preact/hooks';
import { handleSend } from '../app.js';

export function ChatInput() {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const ref = useRef(null);

  async function onSend() {
    if (!text.trim() || sending) return;
    setSending(true);
    const val = text;
    setText('');
    if (ref.current) ref.current.style.height = 'auto';
    await handleSend(val);
    setSending(false);
    ref.current?.focus();
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }

  function onInput(e) {
    setText(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }

  return html`
    <div class="flex gap-2 p-3 px-5 border-t border-border bg-bg-2 items-end">
      <textarea
        ref=${ref}
        class="flex-1 bg-bg-3 border border-border rounded-lg px-3 py-2 text-sm text-txt resize-none focus:outline-none focus:border-accent placeholder-txt-muted font-sans"
        placeholder="Type a message..."
        rows="2"
        value=${text}
        onInput=${onInput}
        onKeyDown=${onKeyDown}
      />
      <button
        class="px-4 py-2 bg-accent text-bg font-semibold rounded-lg text-sm hover:brightness-110 disabled:opacity-40 transition-all"
        onClick=${onSend}
        disabled=${!text.trim() || sending}
      >
        Send
      </button>
    </div>
  `;
}
