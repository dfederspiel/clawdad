import { html } from 'htm/preact';
import { signal } from 'preact/signals';
import { tierProgress } from '../../achievements.js';

export const activeToast = signal(null);

const TIER_LABELS = {
  foundations: 'Foundations',
  builder: 'Builder',
  mastery: 'Mastery',
  meta: 'Legend',
};

/**
 * Show an achievement toast. Called when an SSE 'achievement' event arrives.
 */
export function showAchievementToast(data) {
  activeToast.value = data;
  setTimeout(() => { activeToast.value = null; }, 6000);
}

/**
 * Legacy compatibility — no longer checks telemetry.
 * Achievements are now server-driven via SSE events.
 */
export function checkAchievements() {
  // No-op — achievements are unlocked via IPC and broadcast via SSE
}

export function AchievementToast() {
  const toast = activeToast.value;
  if (!toast) return null;

  const tierLabel = TIER_LABELS[toast.tier] || toast.tier;
  const progress = tierProgress.value?.[toast.tier];
  const progressText = progress
    ? `${progress.unlocked}/${progress.total} ${tierLabel}`
    : '';

  return html`
    <div class="achievement-toast achievement-toast-rich">
      <div class="achievement-toast-header">
        <span class="achievement-toast-badge">ACHIEVEMENT UNLOCKED</span>
        ${toast.xp ? html`<span class="achievement-toast-xp">+${toast.xp} XP</span>` : null}
      </div>
      <div class="achievement-toast-body">
        <span class="achievement-toast-name">${toast.name}</span>
        <span class="achievement-toast-desc">${toast.description}</span>
      </div>
      ${progressText && html`
        <div class="achievement-toast-progress">
          <span>${progressText}</span>
        </div>
      `}
    </div>
  `;
}
