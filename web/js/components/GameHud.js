import { html } from 'htm/preact';
import { computed } from 'preact/signals';
import { telemetry, xpGains } from '../app.js';
import { xpTotal, level, levelProgress, xpInLevel, xpForNext, tierProgress } from '../achievements.js';
import { showPanel } from './AchievementPanel.js';

export const xpData = computed(() => ({
  total: xpTotal.value,
  level: level.value,
  pct: levelProgress.value,
  inLevel: xpInLevel.value,
  forNext: xpForNext.value,
  streak: telemetry.value?.currentStreak || 0,
}));

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

  const gains = xpGains.value;

  return html`
    <div class="game-hud" onClick=${() => { showPanel.value = true; }} style="cursor: pointer; position: relative;" title="${xp.inLevel}/${xp.forNext} XP toward Lv.${xp.level + 1} · click for achievements">
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
      ${gains.length > 0 && html`
        <div class="xp-gain-stack">
          ${gains.map((g) => html`<span key=${g.id} class="xp-gain">+${g.delta} XP</span>`)}
        </div>
      `}
    </div>
  `;
}
