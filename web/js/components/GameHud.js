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
  const progress = tierProgress.value || {};

  // Build tier dots dynamically from progress keys (excluding meta)
  const tierKeys = Object.keys(progress).sort((a, b) => {
    if (a === 'platform') return -1;
    if (b === 'platform') return 1;
    return a.localeCompare(b);
  });

  const tierDots = tierKeys.length > 0 ? html`
    <div class="game-hud-tiers" title="Click for achievements" onClick=${() => { showPanel.value = true; }}>
      ${tierKeys.map((key) => {
        const p = progress[key];
        const complete = p.unlocked === p.total;
        const initial = key[0].toUpperCase();
        return html`
          <span class="tier-dot ${complete ? 'tier-complete' : ''}"
                title="${key.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}: ${p.unlocked}/${p.total}">
            ${initial}
          </span>
        `;
      })}
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
