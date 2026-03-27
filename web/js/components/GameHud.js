import { html } from 'htm/preact';
import { computed } from 'preact/signals';
import { telemetry } from '../app.js';

export const xpData = computed(() => {
  const tel = telemetry.value;
  if (!tel) return { total: 0, level: 1, next: 500, pct: 0, streak: 0 };
  const total = (tel.totalMessages || 0) * 10 + (tel.totalTasksCompleted || 0) * 50;
  const level = Math.floor(total / 500) + 1;
  const next = level * 500;
  const pct = Math.round(((total % 500) / 500) * 100);
  return { total, level, next, pct, streak: tel.currentStreak || 0 };
});

export function GameHud() {
  const xp = xpData.value;

  return html`
    <div class="game-hud">
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
      </div>
    </div>
  `;
}
