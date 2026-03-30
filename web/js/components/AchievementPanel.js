import { html } from 'htm/preact';
import { signal } from 'preact/signals';
import {
  getByTier, xpTotal, level, levelProgress,
  unlockedCount, totalCount, tierProgress,
} from '../achievements.js';

export const showPanel = signal(false);

/** Labels for known tier keys. Pack-defined groups fall back to title case. */
const TIER_LABELS = {
  platform: { label: 'Platform', desc: 'Core capabilities every agent user should know' },
  meta: { label: 'Legend', desc: 'Milestones and streaks' },
};

function tierLabel(key) {
  if (TIER_LABELS[key]) return TIER_LABELS[key];
  // Title-case the key for pack-defined groups (e.g. 'core_skills' → 'Core Skills')
  const label = key.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { label, desc: '' };
}

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

function TierSection({ tierKey }) {
  const achievements = getByTier(tierKey);
  if (achievements.length === 0) return null;
  const unlocked = achievements.filter((a) => a.unlocked).length;
  const info = tierLabel(tierKey);

  return html`
    <div class="ach-tier">
      <div class="ach-tier-header">
        <div>
          <span class="ach-tier-label">${info.label}</span>
          ${info.desc && html`<span class="ach-tier-desc">${info.desc}</span>`}
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

  // Collect unique tier keys from progress (dynamic, pack-driven)
  const progress = tierProgress.value || {};
  const tierKeys = Object.keys(progress);
  // Show 'platform' first, then pack groups, then 'meta' last
  tierKeys.sort((a, b) => {
    if (a === 'platform') return -1;
    if (b === 'platform') return 1;
    return a.localeCompare(b);
  });
  // Always show meta at the end
  tierKeys.push('meta');

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
          ${tierKeys.map((k) => html`<${TierSection} tierKey=${k} />`)}
        </div>
      </div>
    </div>
  `;
}
