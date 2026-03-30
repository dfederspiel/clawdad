/**
 * Achievement system — definitions, storage, and unlock logic.
 *
 * Built-in achievements cover platform-level features (scheduling, threads,
 * agent creation, streaks). Pack-specific achievements (e.g. Jira integration,
 * Confluence reads) are loaded from the active pack's pack.json at startup.
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
  tier: string; // pack category group (e.g. 'first_steps', 'core_skills') or 'meta'
  xp: number;
}

/**
 * Built-in platform achievements — always available regardless of active pack.
 * These cover core platform features, not domain-specific integrations.
 */
const BUILTIN_ACHIEVEMENTS: AchievementDef[] = [
  // Platform features every pack can unlock
  {
    id: 'first_contact',
    name: 'First Contact',
    description: 'Sent your first message to an agent',
    hint: 'Send a message to any agent',
    tier: 'platform',
    xp: 10,
  },
  {
    id: 'clockwork',
    name: 'Clockwork',
    description: 'Set up your first scheduled task',
    hint: 'Ask an agent to do something on a schedule',
    tier: 'platform',
    xp: 50,
  },
  {
    id: 'proactive',
    name: 'Proactive',
    description: 'Received a message an agent sent on its own',
    hint: 'Wait for an agent to reach out to you',
    tier: 'platform',
    xp: 25,
  },
  {
    id: 'good_memory',
    name: 'Good Memory',
    description: 'Agent recalled something from a previous session',
    hint: 'Come back later and see if your agent remembers',
    tier: 'platform',
    xp: 25,
  },
  {
    id: 'night_shift',
    name: 'Night Shift',
    description: 'A scheduled task ran while you were away',
    hint: 'Schedule a task and check back later',
    tier: 'platform',
    xp: 50,
  },
  {
    id: 'thread_weaver',
    name: 'Thread Weaver',
    description: 'Continued a conversation in a thread',
    hint: 'Reply to an agent in a thread',
    tier: 'platform',
    xp: 50,
  },
  {
    id: 'specialist',
    name: 'Specialist',
    description: 'Created a triggered @-mention agent',
    hint: 'Create an agent you can summon with @',
    tier: 'platform',
    xp: 75,
  },
  {
    id: 'cross_talk',
    name: 'Cross-Talk',
    description: 'Used a triggered agent from a different chat',
    hint: 'Use @mention to call an agent from another chat',
    tier: 'platform',
    xp: 75,
  },
  {
    id: 'assembly_line',
    name: 'Assembly Line',
    description: 'Created a workflow with 3+ scheduled tasks',
    hint: 'Build a multi-step automated workflow',
    tier: 'platform',
    xp: 75,
  },
  {
    id: 'apprentice',
    name: 'Apprentice',
    description: 'Taught an agent a new multi-step task',
    hint: 'Walk an agent through a repeatable process',
    tier: 'platform',
    xp: 75,
  },
  {
    id: 'architect',
    name: 'Architect',
    description: 'Running 3+ active agent groups',
    hint: 'Create and run multiple agents',
    tier: 'platform',
    xp: 100,
  },
  {
    id: 'team_player',
    name: 'Team Player',
    description: 'Used agent teams (sub-agents)',
    hint: 'Have an agent spawn helpers',
    tier: 'platform',
    xp: 100,
  },
  {
    id: 'commander',
    name: 'Commander',
    description: 'Created an agent from another agent',
    hint: 'Let an agent create a new agent for you',
    tier: 'platform',
    xp: 100,
  },
  {
    id: 'template_creator',
    name: 'Template Creator',
    description: 'Saved a custom template',
    hint: 'Build something worth reusing',
    tier: 'platform',
    xp: 150,
  },

  // Meta achievements (aggregate, checked via telemetry)
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
  {
    id: 'pack_complete',
    name: 'Completionist',
    description: 'Unlocked every achievement in the active pack',
    hint: 'Unlock all non-meta achievements',
    tier: 'meta',
    xp: 500,
  },
];

// --- Mutable runtime state (built-ins + pack achievements) ---

let allAchievements: AchievementDef[] = [...BUILTIN_ACHIEVEMENTS];
let achievementIds: Set<string> = new Set(allAchievements.map((a) => a.id));
let achievementMap: Map<string, AchievementDef> = new Map(
  allAchievements.map((a) => [a.id, a]),
);

function rebuildIndex(): void {
  achievementIds = new Set(allAchievements.map((a) => a.id));
  achievementMap = new Map(allAchievements.map((a) => [a.id, a]));
}

/**
 * Load achievements from a pack.json file and merge with built-ins.
 * Pack achievements are added alongside built-ins; if a pack defines an ID
 * that conflicts with a built-in, the built-in wins (with a warning log).
 */
export function loadPackAchievements(packJsonPath: string): void {
  let packJson: {
    name?: string;
    achievements?: Record<
      string,
      {
        id: string;
        name: string;
        description: string;
        hint?: string;
        xp?: number;
      }[]
    >;
  };
  try {
    packJson = JSON.parse(fs.readFileSync(packJsonPath, 'utf-8'));
  } catch (err) {
    logger.warn(
      { err, path: packJsonPath },
      'Failed to read pack.json for achievements',
    );
    return;
  }

  const packName = packJson.name || path.basename(path.dirname(packJsonPath));
  if (!packJson.achievements) return;

  // Reset to built-ins before loading (supports pack switching)
  allAchievements = [...BUILTIN_ACHIEVEMENTS];
  rebuildIndex();

  let loaded = 0;
  for (const [groupName, groupAchievements] of Object.entries(
    packJson.achievements,
  )) {
    if (!Array.isArray(groupAchievements)) continue;
    for (const ach of groupAchievements) {
      if (achievementIds.has(ach.id)) {
        // Built-in wins — skip silently (common for shared IDs like first_contact)
        continue;
      }
      allAchievements.push({
        id: ach.id,
        name: ach.name,
        description: ach.description,
        hint: ach.hint || ach.description,
        tier: groupName,
        xp: ach.xp || 10,
      });
      loaded++;
    }
  }

  rebuildIndex();
  logger.info(
    { pack: packName, packAchievements: loaded, total: allAchievements.length },
    'Loaded pack achievements',
  );
}

/**
 * Get achievement list for passing to container agents.
 * Excludes meta achievements (telemetry-driven, not agent-triggered).
 */
export function getAchievementsForContainer(): {
  id: string;
  name: string;
  description: string;
}[] {
  return allAchievements
    .filter((a) => a.tier !== 'meta')
    .map((a) => ({ id: a.id, name: a.name, description: a.description }));
}

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
  if (!achievementIds.has(id)) {
    logger.warn({ id }, 'Unknown achievement ID');
    return null;
  }

  const state = loadAchievements();
  if (state.unlocked[id]) {
    return null; // Already unlocked
  }

  const def = achievementMap.get(id)!;
  state.unlocked[id] = {
    unlockedAt: new Date().toISOString(),
    group,
  };
  state.xp += def.xp;

  saveState(state);
  logger.info({ achievement: id, xp: def.xp, group }, 'Achievement unlocked');

  // Check if this completes all non-meta achievements (pack_complete)
  checkMetaAchievements(state);

  return def;
}

/**
 * Check and unlock meta achievements based on current state.
 * Dynamically checks whether all non-meta achievements are unlocked.
 */
function checkMetaAchievements(state: AchievementState): AchievementDef[] {
  const newlyUnlocked: AchievementDef[] = [];

  // pack_complete: all non-meta achievements unlocked
  const nonMeta = allAchievements.filter((a) => a.tier !== 'meta');
  const allDone = nonMeta.every((a) => state.unlocked[a.id]);
  if (allDone && nonMeta.length > 0 && !state.unlocked['pack_complete']) {
    const def = achievementMap.get('pack_complete');
    if (def) {
      state.unlocked['pack_complete'] = {
        unlockedAt: new Date().toISOString(),
        group: 'meta',
      };
      state.xp += def.xp;
      newlyUnlocked.push(def);
    }
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
    const def = achievementMap.get('centurion')!;
    state.unlocked['centurion'] = {
      unlockedAt: new Date().toISOString(),
      group: 'meta',
    };
    state.xp += def.xp;
    newlyUnlocked.push(def);
  }

  if ((telemetry.currentStreak || 0) >= 7 && !state.unlocked['streak_7']) {
    const def = achievementMap.get('streak_7')!;
    state.unlocked['streak_7'] = {
      unlockedAt: new Date().toISOString(),
      group: 'meta',
    };
    state.xp += def.xp;
    newlyUnlocked.push(def);
  }

  if ((telemetry.currentStreak || 0) >= 30 && !state.unlocked['streak_30']) {
    const def = achievementMap.get('streak_30')!;
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
 * Progress is grouped dynamically by tier (from pack categories + 'platform' + 'meta').
 */
export function getAchievementResponse(): {
  definitions: AchievementDef[];
  state: AchievementState;
  progress: Record<string, { unlocked: number; total: number }>;
} {
  const state = loadAchievements();

  const progress: Record<string, { unlocked: number; total: number }> = {};
  for (const ach of allAchievements) {
    if (ach.tier === 'meta') continue;
    if (!progress[ach.tier]) progress[ach.tier] = { unlocked: 0, total: 0 };
    progress[ach.tier].total++;
    if (state.unlocked[ach.id]) progress[ach.tier].unlocked++;
  }

  return {
    definitions: allAchievements,
    state,
    progress,
  };
}
