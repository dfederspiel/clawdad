import { html } from 'htm/preact';
import { signal } from 'preact/signals';

export const activeToast = signal(null);

const ACHIEVEMENTS = [
  { id: 'hello_world', name: 'Hello World', desc: 'Send your first message', icon: '\uD83D\uDC4B', check: t => (t.totalMessages || 0) >= 1 },
  { id: 'chatterbox', name: 'Chatterbox', desc: '50 messages sent', icon: '\uD83D\uDCAC', check: t => (t.totalMessages || 0) >= 50 },
  { id: 'power_user', name: 'Power User', desc: '100 messages sent', icon: '\u26A1', check: t => (t.totalMessages || 0) >= 100 },
  { id: 'task_rookie', name: 'Task Rookie', desc: 'Complete your first task', icon: '\u2705', check: t => (t.totalTasksCompleted || 0) >= 1 },
  { id: 'task_master', name: 'Task Master', desc: '10 tasks completed', icon: '\uD83C\uDFC6', check: t => (t.totalTasksCompleted || 0) >= 10 },
  { id: 'streak_3', name: 'On Fire', desc: '3-day streak', icon: '\uD83D\uDD25', check: t => (t.currentStreak || 0) >= 3 },
  { id: 'streak_7', name: 'Unstoppable', desc: '7-day streak', icon: '\uD83D\uDCAA', check: t => (t.currentStreak || 0) >= 7 },
];

const STORAGE_KEY = 'clawdad_achievements';

function getUnlocked() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch { return []; }
}

function saveUnlocked(ids) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
}

export function checkAchievements(telemetryData) {
  if (!telemetryData) return;
  const unlocked = getUnlocked();

  for (const ach of ACHIEVEMENTS) {
    if (!unlocked.includes(ach.id) && ach.check(telemetryData)) {
      unlocked.push(ach.id);
      saveUnlocked(unlocked);
      // Show toast
      activeToast.value = ach;
      setTimeout(() => { activeToast.value = null; }, 4000);
      break; // One at a time
    }
  }
}

export function AchievementToast() {
  const toast = activeToast.value;
  if (!toast) return null;

  return html`
    <div class="achievement-toast">
      <span class="achievement-toast-icon">${toast.icon}</span>
      <div class="achievement-toast-text">
        <span class="achievement-toast-title">Achievement Unlocked!</span>
        <span class="achievement-toast-desc">${toast.name} — ${toast.desc}</span>
      </div>
    </div>
  `;
}
