/**
 * XP / level computation. Deterministic — every call recomputes from the
 * underlying activity tables plus achievement-bonus XP, so there's no drift
 * between what the user did and what the HUD shows.
 *
 * Two sources of XP:
 *  - Activity (capped at RETROACTIVE_DAYS): user messages, agent replies,
 *    successful task runs. Earns XP continuously as the user uses the app.
 *  - Achievements: bonus XP from any achievement currently in
 *    state.unlocked. Bonuses come from each achievement's static `xp` field.
 *
 * Level curve: each level requires `100 + 50 · (L-1)²` XP to clear.
 *  - L1→2: 100   (~½ day of light use)
 *  - L2→3: 150
 *  - L3→4: 300
 *  - L4→5: 550
 *  - L5→6: 900
 *  - L10→11: 4150
 */
import { getAllAchievementDefs, loadAchievements } from './achievements.js';
import { getActivityCounts } from './db.js';

export const XP_WEIGHTS = {
  userMessage: 1,
  agentReply: 2,
  taskRun: 5,
} as const;

export const RETROACTIVE_DAYS = 30;

export interface XpBreakdown {
  total: number;
  activity: number;
  achievements: number;
  counts: {
    userMessages: number;
    agentReplies: number;
    taskRuns: number;
  };
  retroactiveDays: number;
}

export function computeXp(): XpBreakdown {
  const cutoff = new Date(
    Date.now() - RETROACTIVE_DAYS * 86_400_000,
  ).toISOString();
  const counts = getActivityCounts(cutoff);

  const activity =
    counts.userMessages * XP_WEIGHTS.userMessage +
    counts.agentReplies * XP_WEIGHTS.agentReply +
    counts.taskRuns * XP_WEIGHTS.taskRun;

  const state = loadAchievements();
  const achievements = getAllAchievementDefs()
    .filter((a) => state.unlocked[a.id])
    .reduce((sum, a) => sum + a.xp, 0);

  return {
    total: activity + achievements,
    activity,
    achievements,
    counts,
    retroactiveDays: RETROACTIVE_DAYS,
  };
}

export function levelThreshold(level: number): number {
  return 100 + 50 * (level - 1) ** 2;
}

export interface LevelInfo {
  level: number;
  xpInLevel: number;
  xpForNext: number;
  pct: number;
}

export function levelFromXp(xp: number): LevelInfo {
  let level = 1;
  let used = 0;
  // Cap at 100 to avoid runaway loops if xp ever explodes.
  while (level < 100 && xp - used >= levelThreshold(level)) {
    used += levelThreshold(level);
    level++;
  }
  const xpInLevel = Math.max(0, xp - used);
  const xpForNext = levelThreshold(level);
  const pct = xpForNext > 0 ? Math.round((xpInLevel / xpForNext) * 100) : 100;
  return { level, xpInLevel, xpForNext, pct };
}
