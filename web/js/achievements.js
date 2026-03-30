/**
 * Achievement registry — client-side definitions and state management.
 * Server is the source of truth (GET /api/achievements).
 * This module handles caching, SSE updates, and progress computation.
 */

import { signal, computed } from 'preact/signals';
import * as api from './api.js';

// --- State ---

export const achievementData = signal(null); // { definitions, state, progress }

// --- Computed ---

export const xpTotal = computed(() => achievementData.value?.state?.xp || 0);
export const level = computed(() => Math.floor(xpTotal.value / 500) + 1);
export const levelProgress = computed(() => Math.round(((xpTotal.value % 500) / 500) * 100));

export const unlockedCount = computed(() => {
  const data = achievementData.value;
  if (!data) return 0;
  return Object.keys(data.state?.unlocked || {}).length;
});

export const totalCount = computed(() => {
  const data = achievementData.value;
  if (!data) return 0;
  return data.definitions?.length || 0;
});

/** Dynamic progress by tier/group — keys come from the server (pack-defined). */
export const tierProgress = computed(() => {
  const data = achievementData.value;
  if (!data?.progress) return {};
  return data.progress;
});

// --- Helpers ---

export function isUnlocked(id) {
  return !!(achievementData.value?.state?.unlocked?.[id]);
}

export function getDefinition(id) {
  return achievementData.value?.definitions?.find((d) => d.id === id);
}

export function getByTier(tier) {
  const data = achievementData.value;
  if (!data) return [];
  return data.definitions.filter((d) => d.tier === tier).map((d) => ({
    ...d,
    unlocked: !!data.state.unlocked[d.id],
    unlockedAt: data.state.unlocked[d.id]?.unlockedAt || null,
  }));
}

// --- API ---

export async function loadAchievements() {
  try {
    achievementData.value = await api.getAchievements();
  } catch { /* ignore */ }
}

/**
 * Handle SSE achievement unlock event. Updates local state immediately
 * so the toast can fire without waiting for a full API refresh.
 */
export function handleAchievementSSE(data) {
  const current = achievementData.value;
  if (!current) return data; // No local state yet — return for toast anyway

  // Update local cache
  const newState = {
    ...current,
    state: {
      ...current.state,
      unlocked: {
        ...current.state.unlocked,
        [data.id]: { unlockedAt: new Date().toISOString(), group: data.group },
      },
      xp: (current.state.xp || 0) + (data.xp || 0),
    },
  };

  // Update tier progress counts (dynamic keys)
  const def = current.definitions.find((d) => d.id === data.id);
  if (def && def.tier !== 'meta' && newState.progress?.[def.tier]) {
    newState.progress = {
      ...newState.progress,
      [def.tier]: {
        ...newState.progress[def.tier],
        unlocked: newState.progress[def.tier].unlocked + 1,
      },
    };
  }

  achievementData.value = newState;
  return data;
}
