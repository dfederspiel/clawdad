/**
 * Achievement system — definitions, storage, and unlock logic.
 *
 * Achievements are stored in groups/global/achievements.json and
 * broadcast via SSE when unlocked.
 */

import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

// --- Achievement Definitions ---

export interface AchievementDef {
  id: string;
  name: string;
  description: string;
  hint: string; // shown when locked — guides discovery
  tier: 'foundations' | 'builder' | 'mastery' | 'meta';
  xp: number;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  // Tier 1 — Foundations (Daily Briefing + Project Tracker)
  {
    id: 'first_contact',
    name: 'First Contact',
    description: 'Sent your first message to an agent',
    hint: 'Send a message to any agent',
    tier: 'foundations',
    xp: 10,
  },
  {
    id: 'clockwork',
    name: 'Clockwork',
    description: 'Set up your first scheduled task',
    hint: 'Ask an agent to do something on a schedule',
    tier: 'foundations',
    xp: 50,
  },
  {
    id: 'proactive',
    name: 'Proactive',
    description: 'Received a message an agent sent on its own',
    hint: 'Wait for an agent to reach out to you',
    tier: 'foundations',
    xp: 25,
  },
  {
    id: 'researcher',
    name: 'Researcher',
    description: 'Had an agent search the web',
    hint: 'Ask an agent to look something up online',
    tier: 'foundations',
    xp: 25,
  },
  {
    id: 'good_memory',
    name: 'Good Memory',
    description: 'Agent recalled something from a previous session',
    hint: 'Come back later and see if your agent remembers',
    tier: 'foundations',
    xp: 25,
  },
  {
    id: 'dashboard',
    name: 'Dashboard',
    description: 'Received a rich card, table, or chart',
    hint: 'Ask for data in a visual format',
    tier: 'foundations',
    xp: 25,
  },
  {
    id: 'plugged_in',
    name: 'Plugged In',
    description: 'Connected your first external service',
    hint: 'Connect Jira, GitHub, or another service',
    tier: 'foundations',
    xp: 50,
  },
  {
    id: 'on_watch',
    name: 'On Watch',
    description: 'Set up a polling task that reported back',
    hint: 'Have an agent monitor something and report',
    tier: 'foundations',
    xp: 50,
  },
  {
    id: 'audit_trail',
    name: 'Audit Trail',
    description: 'Reviewed what an agent has done',
    hint: 'Ask an agent "what have you done?"',
    tier: 'foundations',
    xp: 25,
  },
  {
    id: 'librarian',
    name: 'Librarian',
    description: 'Agent read from Confluence or a wiki',
    hint: 'Connect to Confluence and ask about a page',
    tier: 'foundations',
    xp: 25,
  },
  {
    id: 'ticket_machine',
    name: 'Ticket Machine',
    description: 'Agent created or updated a ticket',
    hint: 'Have an agent create a Jira ticket for you',
    tier: 'foundations',
    xp: 50,
  },
  {
    id: 'night_shift',
    name: 'Night Shift',
    description: 'A scheduled task ran while you were away',
    hint: 'Schedule a task and check back later',
    tier: 'foundations',
    xp: 50,
  },

  // Tier 2 — Builder (Workflow Builder + Specialist + Site Monitor)
  {
    id: 'browser_bot',
    name: 'Browser Bot',
    description: 'Agent navigated a real website',
    hint: 'Have an agent browse a website for you',
    tier: 'builder',
    xp: 75,
  },
  {
    id: 'assembly_line',
    name: 'Assembly Line',
    description: 'Created a workflow with 3+ scheduled tasks',
    hint: 'Build a multi-step automated workflow',
    tier: 'builder',
    xp: 75,
  },
  {
    id: 'apprentice',
    name: 'Apprentice',
    description: 'Taught an agent a new multi-step task',
    hint: 'Walk an agent through a repeatable process',
    tier: 'builder',
    xp: 75,
  },
  {
    id: 'specialist',
    name: 'Specialist',
    description: 'Created a triggered @-mention agent',
    hint: 'Create an agent you can summon with @',
    tier: 'builder',
    xp: 75,
  },
  {
    id: 'cross_talk',
    name: 'Cross-Talk',
    description: 'Used a triggered agent from a different chat',
    hint: 'Use @mention to call an agent from another chat',
    tier: 'builder',
    xp: 75,
  },
  {
    id: 'thread_weaver',
    name: 'Thread Weaver',
    description: 'Continued a conversation in a thread',
    hint: 'Reply to an agent in a thread',
    tier: 'builder',
    xp: 50,
  },
  {
    id: 'sentinel',
    name: 'Sentinel',
    description: 'Set up a website or API monitor',
    hint: 'Have an agent watch a URL for changes',
    tier: 'builder',
    xp: 75,
  },
  {
    id: 'diff_detective',
    name: 'Diff Detective',
    description: 'Received a diff showing what changed',
    hint: 'Get a before/after comparison from an agent',
    tier: 'builder',
    xp: 50,
  },

  // Tier 3 — Mastery (Command Center)
  {
    id: 'architect',
    name: 'Architect',
    description: 'Running 3+ active agent groups',
    hint: 'Create and run multiple agents',
    tier: 'mastery',
    xp: 100,
  },
  {
    id: 'team_player',
    name: 'Team Player',
    description: 'Used agent teams (sub-agents)',
    hint: 'Have an agent spawn helpers',
    tier: 'mastery',
    xp: 100,
  },
  {
    id: 'commander',
    name: 'Commander',
    description: 'Created an agent from another agent',
    hint: 'Let an agent create a new agent for you',
    tier: 'mastery',
    xp: 100,
  },
  {
    id: 'template_creator',
    name: 'Template Creator',
    description: 'Saved a custom template',
    hint: 'Build something worth reusing',
    tier: 'mastery',
    xp: 150,
  },

  // Meta achievements (aggregate, checked via telemetry)
  {
    id: 'foundations_complete',
    name: 'Foundation Graduate',
    description: 'Unlocked all Foundation achievements',
    hint: 'Complete all 12 Foundation achievements',
    tier: 'meta',
    xp: 200,
  },
  {
    id: 'builder_complete',
    name: 'Master Builder',
    description: 'Unlocked all Builder achievements',
    hint: 'Complete all 8 Builder achievements',
    tier: 'meta',
    xp: 300,
  },
  {
    id: 'mastery_complete',
    name: 'Grand Architect',
    description: 'Unlocked all Mastery achievements',
    hint: 'Complete all 4 Mastery achievements',
    tier: 'meta',
    xp: 500,
  },
  {
    id: 'centurion',
    name: 'Centurion',
    description: '100 messages sent across all agents',
    hint: "Keep chatting — you're getting close",
    tier: 'meta',
    xp: 100,
  },
  {
    id: 'streak_7',
    name: 'On Fire',
    description: '7-day activity streak',
    hint: 'Use ClawDad 7 days in a row',
    tier: 'meta',
    xp: 100,
  },
  {
    id: 'streak_30',
    name: 'Unstoppable',
    description: '30-day activity streak',
    hint: 'Use ClawDad 30 days in a row',
    tier: 'meta',
    xp: 250,
  },
];

const ACHIEVEMENT_IDS = new Set(ACHIEVEMENTS.map((a) => a.id));
const ACHIEVEMENT_MAP = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

// --- State ---

export interface AchievementUnlock {
  unlockedAt: string;
  group: string;
}

export interface AchievementState {
  unlocked: Record<string, AchievementUnlock>;
  xp: number;
  streak: { current: number; lastActive: string };
}

const EMPTY_STATE: AchievementState = {
  unlocked: {},
  xp: 0,
  streak: { current: 0, lastActive: '' },
};

let cachedState: AchievementState | null = null;

function achievementsPath(): string {
  return path.join(GROUPS_DIR, 'global', 'achievements.json');
}

export function loadAchievements(): AchievementState {
  if (cachedState) return cachedState;

  const filePath = achievementsPath();
  if (!fs.existsSync(filePath)) {
    cachedState = {
      ...EMPTY_STATE,
      unlocked: {},
      streak: { current: 0, lastActive: '' },
    };
    return cachedState;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    cachedState = {
      unlocked: raw.unlocked || {},
      xp: raw.xp || 0,
      streak: raw.streak || { current: 0, lastActive: '' },
    };
    return cachedState;
  } catch (err) {
    logger.warn({ err }, 'Failed to read achievements.json, starting fresh');
    cachedState = {
      ...EMPTY_STATE,
      unlocked: {},
      streak: { current: 0, lastActive: '' },
    };
    return cachedState;
  }
}

function saveState(state: AchievementState): void {
  const dir = path.dirname(achievementsPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(achievementsPath(), JSON.stringify(state, null, 2) + '\n');
  cachedState = state;
}

/**
 * Attempt to unlock an achievement. Returns the definition if newly unlocked,
 * or null if already unlocked or invalid.
 */
export function unlockAchievement(
  id: string,
  group: string,
): AchievementDef | null {
  if (!ACHIEVEMENT_IDS.has(id)) {
    logger.warn({ id }, 'Unknown achievement ID');
    return null;
  }

  const state = loadAchievements();
  if (state.unlocked[id]) {
    return null; // Already unlocked
  }

  const def = ACHIEVEMENT_MAP.get(id)!;
  state.unlocked[id] = {
    unlockedAt: new Date().toISOString(),
    group,
  };
  state.xp += def.xp;

  saveState(state);
  logger.info({ achievement: id, xp: def.xp, group }, 'Achievement unlocked');

  // Check if this completes a tier (meta achievements)
  checkMetaAchievements(state);

  return def;
}

/**
 * Check and unlock meta achievements based on current state.
 * Returns array of newly unlocked meta achievements.
 */
function checkMetaAchievements(state: AchievementState): AchievementDef[] {
  const newlyUnlocked: AchievementDef[] = [];

  const foundationsAll = ACHIEVEMENTS.filter(
    (a) => a.tier === 'foundations',
  ).every((a) => state.unlocked[a.id]);
  if (foundationsAll && !state.unlocked['foundations_complete']) {
    const def = ACHIEVEMENT_MAP.get('foundations_complete')!;
    state.unlocked['foundations_complete'] = {
      unlockedAt: new Date().toISOString(),
      group: 'meta',
    };
    state.xp += def.xp;
    newlyUnlocked.push(def);
  }

  const builderAll = ACHIEVEMENTS.filter((a) => a.tier === 'builder').every(
    (a) => state.unlocked[a.id],
  );
  if (builderAll && !state.unlocked['builder_complete']) {
    const def = ACHIEVEMENT_MAP.get('builder_complete')!;
    state.unlocked['builder_complete'] = {
      unlockedAt: new Date().toISOString(),
      group: 'meta',
    };
    state.xp += def.xp;
    newlyUnlocked.push(def);
  }

  const masteryAll = ACHIEVEMENTS.filter((a) => a.tier === 'mastery').every(
    (a) => state.unlocked[a.id],
  );
  if (masteryAll && !state.unlocked['mastery_complete']) {
    const def = ACHIEVEMENT_MAP.get('mastery_complete')!;
    state.unlocked['mastery_complete'] = {
      unlockedAt: new Date().toISOString(),
      group: 'meta',
    };
    state.xp += def.xp;
    newlyUnlocked.push(def);
  }

  if (newlyUnlocked.length > 0) {
    saveState(state);
  }

  return newlyUnlocked;
}

/**
 * Check telemetry-based meta achievements (centurion, streaks).
 * Called periodically with telemetry data.
 * Returns array of newly unlocked achievements.
 */
export function checkTelemetryAchievements(telemetry: {
  totalMessages?: number;
  currentStreak?: number;
}): AchievementDef[] {
  const state = loadAchievements();
  const newlyUnlocked: AchievementDef[] = [];

  if ((telemetry.totalMessages || 0) >= 100 && !state.unlocked['centurion']) {
    const def = ACHIEVEMENT_MAP.get('centurion')!;
    state.unlocked['centurion'] = {
      unlockedAt: new Date().toISOString(),
      group: 'meta',
    };
    state.xp += def.xp;
    newlyUnlocked.push(def);
  }

  if ((telemetry.currentStreak || 0) >= 7 && !state.unlocked['streak_7']) {
    const def = ACHIEVEMENT_MAP.get('streak_7')!;
    state.unlocked['streak_7'] = {
      unlockedAt: new Date().toISOString(),
      group: 'meta',
    };
    state.xp += def.xp;
    newlyUnlocked.push(def);
  }

  if ((telemetry.currentStreak || 0) >= 30 && !state.unlocked['streak_30']) {
    const def = ACHIEVEMENT_MAP.get('streak_30')!;
    state.unlocked['streak_30'] = {
      unlockedAt: new Date().toISOString(),
      group: 'meta',
    };
    state.xp += def.xp;
    newlyUnlocked.push(def);
  }

  if (newlyUnlocked.length > 0) {
    saveState(state);
  }

  return newlyUnlocked;
}

/**
 * Get achievement state for API response.
 */
export function getAchievementResponse(): {
  definitions: AchievementDef[];
  state: AchievementState;
  progress: {
    foundations: { unlocked: number; total: number };
    builder: { unlocked: number; total: number };
    mastery: { unlocked: number; total: number };
  };
} {
  const state = loadAchievements();

  const countTier = (tier: AchievementDef['tier']) => {
    const all = ACHIEVEMENTS.filter((a) => a.tier === tier);
    const unlocked = all.filter((a) => state.unlocked[a.id]).length;
    return { unlocked, total: all.length };
  };

  return {
    definitions: ACHIEVEMENTS,
    state,
    progress: {
      foundations: countTier('foundations'),
      builder: countTier('builder'),
      mastery: countTier('mastery'),
    },
  };
}
