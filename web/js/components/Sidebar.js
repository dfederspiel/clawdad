import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { groups, selectedJid, selectGroup, messages, lastActivityOverride } from '../app.js';
import { GroupItem } from './GroupItem.js';
import { GroupSettings } from './GroupSettings.js';
import { NewGroupDialog } from './NewGroupDialog.js';
import { StatusPanel } from './StatusPanel.js';
import { GameHud } from './GameHud.js';
import { ThemeMenu } from './ThemeMenu.js';
import { sortGroups } from '../sort-groups.js';

const SORT_STORAGE_KEY = 'clawdad.sidebar.sortMode';
const SORT_MODES = [
  { id: 'name', label: 'Name' },
  { id: 'recent', label: 'Recent activity' },
  { id: 'upcoming', label: 'Upcoming schedule' },
];

const SIDEBAR_WIDTH_KEY = 'clawdad.sidebar.width';
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 250;
const DESKTOP_MQ = '(min-width: 768px)';

function readSortMode() {
  try {
    const v = localStorage.getItem(SORT_STORAGE_KEY);
    if (SORT_MODES.some((m) => m.id === v)) return v;
  } catch {
    // localStorage unavailable (private mode, SSR, etc.)
  }
  return 'name';
}

function readSidebarWidth() {
  try {
    const v = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) || '', 10);
    if (Number.isFinite(v) && v >= MIN_WIDTH && v <= MAX_WIDTH) return v;
  } catch {
    // ignore
  }
  return DEFAULT_WIDTH;
}

export function Sidebar({ open, onClose }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [settingsGroup, setSettingsGroup] = useState(null);
  const [sortMode, setSortMode] = useState(readSortMode);
  const [width, setWidth] = useState(readSidebarWidth);
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window === 'undefined' ? true : window.matchMedia(DESKTOP_MQ).matches,
  );
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragRef = useRef({ active: false, startX: 0, startWidth: 0, pointerId: -1 });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(DESKTOP_MQ);
    const handler = (e) => setIsDesktop(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  function onResizePointerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startWidth: widthRef.current,
      pointerId: e.pointerId,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function onResizePointerMove(e) {
    if (!dragRef.current.active) return;
    const dx = e.clientX - dragRef.current.startX;
    const next = Math.max(
      MIN_WIDTH,
      Math.min(MAX_WIDTH, dragRef.current.startWidth + dx),
    );
    setWidth(next);
  }

  function onResizePointerUp(e) {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    try {
      e.currentTarget.releasePointerCapture(dragRef.current.pointerId);
    } catch {
      // capture may already be released (cancel events)
    }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(widthRef.current));
    } catch {
      // ignore
    }
  }

  function onResizeDoubleClick() {
    setWidth(DEFAULT_WIDTH);
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(DEFAULT_WIDTH));
    } catch {
      // ignore
    }
  }

  function onSortChange(e) {
    const next = e.target.value;
    setSortMode(next);
    try {
      localStorage.setItem(SORT_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }

  const list = sortGroups(groups.value, sortMode, lastActivityOverride.value);
  const selected = selectedJid.value;

  function onGroupSelect(jid) {
    // Toggle: clicking the active group deselects it, showing the template picker
    if (jid === selected) {
      selectedJid.value = null;
      messages.value = [];
    } else {
      selectGroup(jid);
    }
    onClose();
  }

  return html`
    <!-- Backdrop (mobile only) -->
    ${open && html`
      <div
        class="fixed inset-0 bg-black/50 z-30 md:hidden"
        onClick=${onClose}
      />
    `}

    <!-- Sidebar -->
    <aside
      class="
        fixed inset-y-0 left-0 z-40 w-[280px]
        bg-bg-2 border-r border-border flex flex-col
        transform transition-transform duration-200 ease-out
        ${open ? 'translate-x-0' : '-translate-x-full'}
        md:relative md:translate-x-0 md:z-auto md:flex-shrink-0
      "
      style=${isDesktop ? `width: ${width}px; min-width: ${width}px` : ''}
    >
      <!-- Resize handle (desktop only). Drag to resize, double-click to reset. -->
      <div
        class="hidden md:block absolute top-0 right-0 bottom-0 w-1 -mr-0.5 cursor-col-resize hover:bg-accent/40 active:bg-accent/60 transition-colors z-50"
        onPointerDown=${onResizePointerDown}
        onPointerMove=${onResizePointerMove}
        onPointerUp=${onResizePointerUp}
        onPointerCancel=${onResizePointerUp}
        onDblClick=${onResizeDoubleClick}
        title="Drag to resize · double-click to reset"
      />
      <div class="flex items-center justify-between px-4 py-3 border-b border-border">
        <div>
          <h1 class="text-base font-semibold text-txt leading-tight">ClawDad</h1>
          <p class="text-[10px] text-txt-muted leading-tight">Agent Orchestrator</p>
        </div>
        <div class="flex items-center gap-1">
          <!-- Close button (mobile only) -->
          <button
            class="w-7 h-7 flex items-center justify-center rounded-md text-txt-2 hover:bg-bg-hover hover:text-txt transition-colors md:hidden"
            title="Close"
            onClick=${onClose}
          >
            <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
            </svg>
          </button>
          <div class="relative">
            <button
              class="w-7 h-7 flex items-center justify-center rounded-md text-txt-2 hover:bg-bg-hover hover:text-txt transition-colors"
              title="Theme"
              onClick=${(e) => { e.stopPropagation(); setThemeOpen(!themeOpen); }}
            >
              <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M4 2a2 2 0 00-2 2v11a3 3 0 106 0V4a2 2 0 00-2-2H4zm1 14a1 1 0 100-2 1 1 0 000 2zm5-1.757l4.9-4.9a2 2 0 000-2.828L13.485 5.1a2 2 0 00-2.828 0L10 5.757v8.486zM16 18H9.071l6-6H16a2 2 0 012 2v2a2 2 0 01-2 2z" clip-rule="evenodd"/>
              </svg>
            </button>
            <${ThemeMenu} open=${themeOpen} onClose=${() => setThemeOpen(false)} />
          </div>
          <button
            class="w-7 h-7 flex items-center justify-center rounded-md text-txt-2 hover:bg-bg-hover hover:text-txt transition-colors text-lg leading-none"
            title="New group"
            onClick=${() => setDialogOpen(true)}
          >
            +
          </button>
        </div>
      </div>
      <${GameHud} />
      ${list.length > 1 && html`
        <div class="px-3 pt-2 pb-1 flex items-center gap-2">
          <label class="text-[10px] uppercase tracking-wide text-txt-2" for="group-sort">
            Sort
          </label>
          <select
            id="group-sort"
            class="flex-1 min-w-0 text-xs bg-bg-3 border border-border rounded-lg px-2 py-1.5 text-txt focus:outline-none focus:border-accent"
            value=${sortMode}
            onChange=${onSortChange}
          >
            ${SORT_MODES.map(
              (m) => html`<option value=${m.id}>${m.label}</option>`,
            )}
          </select>
        </div>
      `}
      <div class="flex-1 overflow-y-auto py-1">
        ${list.length === 0
          ? html`
              <div class="px-4 py-3 text-xs text-txt-muted">
                No web groups yet. Click + to create one.
              </div>
            `
          : list.map(
              (g) => html`
                <${GroupItem}
                  key=${g.jid}
                  group=${g}
                  isActive=${g.jid === selected}
                  onSelect=${onGroupSelect}
                  onSettings=${setSettingsGroup}
                />
              `,
            )}
      </div>
      <${StatusPanel} />
    </aside>

    <!-- Dialogs rendered outside sidebar so they center on the page -->
    <${NewGroupDialog} open=${dialogOpen} onClose=${() => setDialogOpen(false)} />
    <${GroupSettings}
      group=${settingsGroup}
      open=${!!settingsGroup}
      onClose=${() => setSettingsGroup(null)}
    />
  `;
}
