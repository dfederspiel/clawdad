import { html } from 'htm/preact';
import { useState, useRef, useEffect, useMemo } from 'preact/hooks';
import { handleSend, triggers, selectedGroup, pendingInput } from '../app.js';

export function ChatInput() {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionStart, setMentionStart] = useState(-1); // cursor position of '@'
  const ref = useRef(null);
  const menuRef = useRef(null);

  // Refs so onKeyDown always sees current values (avoids stale closures)
  const showMentionsRef = useRef(false);
  const filteredRef = useRef([]);
  const mentionIndexRef = useRef(0);
  showMentionsRef.current = showMentions;
  mentionIndexRef.current = mentionIndex;

  // Watch for external input injection (e.g. clicking an @mention in a message)
  useEffect(() => {
    if (pendingInput.value) {
      const inject = pendingInput.value;
      pendingInput.value = '';
      setText((prev) => {
        // Append to existing text, or set fresh
        const base = prev.trim();
        return base ? `${base} ${inject} ` : `${inject} `;
      });
      requestAnimationFrame(() => ref.current?.focus());
    }
  }, [pendingInput.value]);

  // Combine global triggers with current group's agent triggers
  const allTriggers = useMemo(() => {
    const group = selectedGroup.value;
    const agentTriggers = (group?.agents || [])
      .filter((a) => a.trigger) // only agents with explicit triggers
      .map((a) => ({
        jid: a.id,
        name: a.displayName,
        trigger: a.trigger,
        description: `Agent in ${group.name}`,
        isAgent: true,
      }));
    const global = triggers.value.map((t) => ({ ...t, isAgent: false }));
    return [...agentTriggers, ...global];
  }, [selectedGroup.value, triggers.value]);

  // Filter triggers by query
  const filtered = allTriggers.filter((t) =>
    !mentionQuery || t.name.toLowerCase().includes(mentionQuery.toLowerCase())
      || t.trigger.toLowerCase().includes(mentionQuery.toLowerCase()),
  );
  filteredRef.current = filtered;

  // Close menu on outside click
  useEffect(() => {
    if (!showMentions) return;
    function onClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setShowMentions(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showMentions]);

  function insertMention(trigger) {
    const before = text.slice(0, mentionStart);
    const after = text.slice(ref.current?.selectionStart || mentionStart);
    const newText = `${before}${trigger.trigger} ${after}`;
    setText(newText);
    setShowMentions(false);
    setMentionQuery('');
    setMentionStart(-1);
    // Focus and set cursor after the inserted trigger
    requestAnimationFrame(() => {
      if (ref.current) {
        const pos = before.length + trigger.trigger.length + 1;
        ref.current.focus();
        ref.current.setSelectionRange(pos, pos);
      }
    });
  }

  async function onSend() {
    if (!text.trim() || sending) return;
    setSending(true);
    const val = text;
    setText('');
    setShowMentions(false);
    if (ref.current) ref.current.style.height = 'auto';
    await handleSend(val);
    setSending(false);
    ref.current?.focus();
  }

  function onKeyDown(e) {
    const menuOpen = showMentionsRef.current;
    const items = filteredRef.current;
    const idx = mentionIndexRef.current;
    if (menuOpen && items.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = (idx + 1) % items.length;
        setMentionIndex(next);
        mentionIndexRef.current = next;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const next = (idx - 1 + items.length) % items.length;
        setMentionIndex(next);
        mentionIndexRef.current = next;
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(items[idx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowMentions(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }

  function onInput(e) {
    const val = e.target.value;
    setText(val);

    // Auto-resize
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';

    // Check for @-mention trigger
    if (allTriggers.length > 0) {
      const cursor = el.selectionStart;
      const textBeforeCursor = val.slice(0, cursor);
      // Find the last @ that starts a word (preceded by start-of-string, space, or newline)
      const match = textBeforeCursor.match(/(?:^|[\s\n])@(\w*)$/);
      if (match) {
        const atPos = textBeforeCursor.lastIndexOf('@');
        setMentionStart(atPos);
        setMentionQuery(match[1]);
        setMentionIndex(0);
        setShowMentions(true);
      } else {
        setShowMentions(false);
      }
    }
  }

  return html`
    <div class="relative flex gap-2 p-3 px-3 md:px-5 border-t border-border bg-bg-2 items-end">
      ${showMentions && filtered.length > 0 && html`
        <div
          ref=${menuRef}
          class="absolute bottom-full left-5 right-5 mb-1 bg-bg-3 border border-border rounded-lg shadow-lg overflow-hidden max-h-48 overflow-y-auto z-50"
        >
          ${filtered.map((t, i) => html`
            <button
              type="button"
              key=${t.jid}
              class="w-full text-left px-3 py-2 flex flex-col gap-0.5 transition-colors ${
                i === mentionIndex ? 'bg-bg-hover border-l-2 border-accent' : 'hover:bg-bg-hover/50 border-l-2 border-transparent'
              }"
              onMouseEnter=${() => setMentionIndex(i)}
              onClick=${() => insertMention(t)}
            >
              <span class="text-sm text-txt font-medium">
                <span class="text-accent font-mono">${t.trigger}</span>
                ${' '}${t.name}
                ${t.isAgent && html`
                  <span class="text-[10px] text-txt-muted ml-1 font-normal">agent</span>
                `}
              </span>
              ${t.description && html`
                <span class="text-xs text-txt-muted truncate">${t.description}</span>
              `}
            </button>
          `)}
        </div>
      `}
      <textarea
        ref=${ref}
        class="flex-1 min-w-0 bg-bg-3 border border-border rounded-lg px-3 py-2 text-sm text-txt resize-none focus:outline-none focus:border-accent placeholder-txt-muted font-sans"
        placeholder="Type a message..."
        rows="1"
        value=${text}
        onInput=${onInput}
        onKeyDown=${onKeyDown}
      />
      <button
        class="shrink-0 w-9 h-9 flex items-center justify-center bg-accent text-bg rounded-full hover:brightness-110 disabled:opacity-40 transition-all"
        onClick=${onSend}
        disabled=${!text.trim() || sending}
        title="Send"
      >
        <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M10 17a.75.75 0 01-.75-.75V5.612L5.29 9.77a.75.75 0 01-1.08-1.04l5.25-5.5a.75.75 0 011.08 0l5.25 5.5a.75.75 0 11-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0110 17z" clip-rule="evenodd"/>
        </svg>
      </button>
    </div>
  `;
}
