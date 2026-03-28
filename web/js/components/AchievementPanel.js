import { html } from 'htm/preact';
import { signal } from 'preact/signals';
import {
  getByTier, xpTotal, level, levelProgress,
  unlockedCount, totalCount,
} from '../achievements.js';

export const showPanel = signal(false);

const TIERS = [
  { key: 'foundations', label: 'Foundations', desc: 'Core capabilities every agent user should know' },
  { key: 'builder', label: 'Builder', desc: 'Advanced automation and cross-agent workflows' },
  { key: 'mastery', label: 'Mastery', desc: 'Orchestrate multiple agents like a pro' },
  { key: 'meta', label: 'Legend', desc: 'Milestones and streaks' },
];

function AchievementCard({ achievement }) {
  const locked = !achievement.unlocked;

  return html`
    <div class="ach-card ${locked ? 'ach-locked' : 'ach-unlocked'}">
      <div class="ach-card-header">
        <span class="ach-card-name">${achievement.name}</span>
        <span class="ach-card-xp">${achievement.xp} XP</span>
      </div>
      <div class="ach-card-body">
        ${locked
          ? html`<span class="ach-card-hint">${achievement.hint}</span>`
          : html`<span class="ach-card-desc">${achievement.description}</span>`
        }
      </div>
      ${!locked && achievement.unlockedAt && html`
        <div class="ach-card-date">
          ${new Date(achievement.unlockedAt).toLocaleDateString()}
        </div>
      `}
    </div>
  `;
}

function TierSection({ tier }) {
  const achievements = getByTier(tier.key);
  const unlocked = achievements.filter((a) => a.unlocked).length;

  return html`
    <div class="ach-tier">
      <div class="ach-tier-header">
        <div>
          <span class="ach-tier-label">${tier.label}</span>
          <span class="ach-tier-desc">${tier.desc}</span>
        </div>
        <span class="ach-tier-count">${unlocked}/${achievements.length}</span>
      </div>
      <div class="ach-tier-grid">
        ${achievements.map((a) => html`<${AchievementCard} achievement=${a} />`)}
      </div>
    </div>
  `;
}

export function AchievementPanel() {
  if (!showPanel.value) return null;

  return html`
    <div class="ach-overlay" onClick=${() => { showPanel.value = false; }}>
      <div class="ach-panel" onClick=${(e) => e.stopPropagation()}>
        <div class="ach-panel-header">
          <h2>Achievements</h2>
          <button class="ach-close" onClick=${() => { showPanel.value = false; }}>x</button>
        </div>

        <div class="ach-summary">
          <div class="ach-summary-stat">
            <span class="ach-summary-value">LV.${level.value}</span>
            <span class="ach-summary-label">Level</span>
          </div>
          <div class="ach-summary-stat">
            <span class="ach-summary-value">${xpTotal.value}</span>
            <span class="ach-summary-label">Total XP</span>
          </div>
          <div class="ach-summary-stat">
            <span class="ach-summary-value">${unlockedCount.value}/${totalCount.value}</span>
            <span class="ach-summary-label">Unlocked</span>
          </div>
        </div>

        <div class="ach-xp-bar">
          <div class="ach-xp-fill" style="width: ${levelProgress.value}%" />
        </div>

        <div class="ach-tiers">
          ${TIERS.map((t) => html`<${TierSection} tier=${t} />`)}
        </div>
      </div>
    </div>
  `;
}
