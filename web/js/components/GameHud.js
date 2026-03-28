import { html } from 'htm/preact';
import { computed } from 'preact/signals';
import { telemetry } from '../app.js';
import { xpTotal, level, levelProgress, tierProgress } from '../achievements.js';
import { showPanel } from './AchievementPanel.js';

export const xpData = computed(() => {
  const tel = telemetry.value;
  // Use achievement-based XP if available, fall back to telemetry-based
  const achXp = xpTotal.value;
  const total = achXp > 0
    ? achXp
    : (tel?.totalMessages || 0) * 10 + (tel?.totalTasksCompleted || 0) * 50;
  const lv = achXp > 0 ? level.value : Math.floor(total / 500) + 1;
  const pct = achXp > 0 ? levelProgress.value : Math.round(((total % 500) / 500) * 100);
  return { total, level: lv, pct, streak: tel?.currentStreak || 0 };
});

export function GameHud() {
  const xp = xpData.value;
  const progress = tierProgress.value;

  // Compact tier progress indicator
  const tierDots = progress?.foundations ? html`
    <div class="game-hud-tiers" title="Click for achievements" onClick=${() => { showPanel.value = true; }}>
      <span class="tier-dot ${progress.foundations?.unlocked === progress.foundations?.total ? 'tier-complete' : ''}"
            title="Foundations: ${progress.foundations?.unlocked || 0}/${progress.foundations?.total || 0}">F</span>
      <span class="tier-dot ${progress.builder?.unlocked === progress.builder?.total ? 'tier-complete' : ''}"
            title="Builder: ${progress.builder?.unlocked || 0}/${progress.builder?.total || 0}">B</span>
      <span class="tier-dot ${progress.mastery?.unlocked === progress.mastery?.total ? 'tier-complete' : ''}"
            title="Mastery: ${progress.mastery?.unlocked || 0}/${progress.mastery?.total || 0}">M</span>
    </div>
  ` : null;

  return html`
    <div class="game-hud" onClick=${() => { showPanel.value = true; }} style="cursor: pointer;" title="View achievements">
      <div class="flex items-center justify-between">
        <span class="game-hud-level">LV.${xp.level}</span>
        <span style="font-size: 10px; color: #5e6275; font-family: monospace;">
          ${xp.total} XP
        </span>
      </div>
      <div class="game-hud-xp-track">
        <div class="game-hud-xp-fill" style="width: ${xp.pct}%" />
      </div>
      <div class="game-hud-stats">
        ${xp.streak > 0 && html`
          <span class="game-hud-streak">\uD83D\uDD25 ${xp.streak}d streak</span>
        `}
        ${tierDots}
      </div>
    </div>
  `;
}
