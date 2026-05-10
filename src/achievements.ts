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
import { platformAchievementPredicates } from './db.js';
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
/** All registered achievement definitions (built-ins + active pack). */
export function getAllAchievementDefs(): AchievementDef[] {
  return allAchievements;
}

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
}

const EMPTY_STATE: AchievementState = {
  unlocked: {},
  xp: 0,
};

let cachedState: AchievementState | null = null;
let testMode = false;

function achievementsPath(): string {
  return path.join(GROUPS_DIR, 'global', 'achievements.json');
}

export function loadAchievements(): AchievementState {
  if (cachedState) return cachedState;

  const filePath = achievementsPath();
  if (!fs.existsSync(filePath)) {
    cachedState = { ...EMPTY_STATE, unlocked: {} };
    return cachedState;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    // raw.streak (if present in legacy files) is intentionally ignored —
    // the live streak is derived deterministically from message dates in
    // getTelemetryStats. The orphan field falls out on the next save.
    cachedState = {
      unlocked: raw.unlocked || {},
      xp: raw.xp || 0,
    };
    return cachedState;
  } catch (err) {
    logger.warn({ err }, 'Failed to read achievements.json, starting fresh');
    cachedState = { ...EMPTY_STATE, unlocked: {} };
    return cachedState;
  }
}

function saveState(state: AchievementState): void {
  if (testMode) {
    // Test isolation: never touch the user's real achievements.json.
    cachedState = state;
    return;
  }
  const dir = path.dirname(achievementsPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(achievementsPath(), JSON.stringify(state, null, 2) + '\n');
  cachedState = state;
}

/**
 * Attempt to unlock an achievement. Returns the definition if newly unlocked,
 * or null if already unlocked or invalid.
 */
/**
 * Broadcast hook for newly-unlocked achievements. Set once at startup by
 * index.ts so any unlock site (deterministic checks, IPC, telemetry) fires
 * the SSE event without each caller having to plumb the channel.
 */
let broadcaster: ((def: AchievementDef, group: string) => void) | null = null;

export function setAchievementBroadcaster(
  fn: (def: AchievementDef, group: string) => void,
): void {
  broadcaster = fn;
}

/** @internal - for tests only. */
export function _clearAchievementBroadcaster(): void {
  broadcaster = null;
}

/**
 * @internal - for tests only. Installs an empty state in cache and enables
 * test mode so subsequent saves don't touch the real achievements.json.
 */
export function _resetAchievementCacheForTests(): void {
  testMode = true;
  cachedState = { unlocked: {}, xp: 0 };
}

function emitUnlock(def: AchievementDef, group: string): void {
  if (broadcaster) {
    try {
      broadcaster(def, group);
    } catch (err) {
      logger.warn(
        { id: def.id, err },
        'Achievement broadcaster threw — unlock recorded but SSE event lost',
      );
    }
  }
}

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
  emitUnlock(def, group);

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
      emitUnlock(def, 'meta');
    }
  }

  if (newlyUnlocked.length > 0) {
    saveState(state);
  }

  return newlyUnlocked;
}

/**
 * Deterministically detect platform achievements that are observable from
 * orchestrator state (DB rows, registered groups, agent.json files). Cheap —
 * each check short-circuits on already-unlocked, and the underlying queries
 * are EXISTS on indexed columns. Safe to call on every state-changing event.
 *
 * Replaces the old contract where most platform unlocks required the agent
 * to call mcp__nanoclaw__unlock_achievement (unreliable: LLMs forget,
 * smaller Ollama models can't reliably call MCP, descriptions are vague).
 *
 * The genuinely-semantic ones (good_memory, apprentice, commander) remain
 * reachable only via the agent-driven IPC path — they live in the def list
 * but no deterministic check fires them.
 */
export function checkPlatformAchievements(deps?: {
  registeredGroupCount?: number;
  groupFolders?: string[];
}): AchievementDef[] {
  const state = loadAchievements();
  const newlyUnlocked: AchievementDef[] = [];

  // Short-circuit: all platform achievements we deterministically detect
  // are already unlocked, no point running predicates.
  const detectableIds = [
    'first_contact',
    'clockwork',
    'assembly_line',
    'architect',
    'team_player',
    'specialist',
    'thread_weaver',
    'night_shift',
  ];
  if (detectableIds.every((id) => state.unlocked[id])) {
    return newlyUnlocked;
  }

  const fire = (id: string, group = 'platform'): void => {
    if (state.unlocked[id]) return;
    if (!achievementIds.has(id)) return;
    const def = achievementMap.get(id)!;
    state.unlocked[id] = { unlockedAt: new Date().toISOString(), group };
    state.xp += def.xp;
    newlyUnlocked.push(def);
    emitUnlock(def, group);
  };

  const preds = platformAchievementPredicates();

  if (preds.hasUserMessage) fire('first_contact');
  if (preds.hasScheduledTask) fire('clockwork');
  if (preds.hasGroupWithThreeOrMoreTasks) fire('assembly_line');
  if (preds.hasUserThreadReply) fire('thread_weaver');
  if (preds.hasNightShiftTaskRun) fire('night_shift');

  if ((deps?.registeredGroupCount ?? 0) >= 3) fire('architect');

  // team_player + specialist need an on-disk scan: any group folder with
  // an agents/ subdirectory containing ≥1 agent.json wired up. The caller
  // passes the candidate folder list so we don't re-resolve registered
  // groups in the achievements module.
  if (deps?.groupFolders && deps.groupFolders.length > 0) {
    let multiAgent = false;
    let specialist = false;
    for (const folder of deps.groupFolders) {
      const agentsDir = path.join(GROUPS_DIR, folder, 'agents');
      if (!fs.existsSync(agentsDir) || !fs.statSync(agentsDir).isDirectory())
        continue;
      const entries = fs.readdirSync(agentsDir);
      let count = 0;
      for (const entry of entries) {
        const cfgPath = path.join(agentsDir, entry, 'agent.json');
        if (!fs.existsSync(cfgPath)) continue;
        count++;
        try {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
          if (typeof cfg.trigger === 'string' && cfg.trigger.length > 0) {
            specialist = true;
          }
        } catch {
          /* malformed agent.json — skip */
        }
      }
      if (count >= 2) multiAgent = true;
      if (specialist && multiAgent) break;
    }
    if (multiAgent) fire('team_player');
    if (specialist) fire('specialist');
  }

  if (newlyUnlocked.length > 0) {
    saveState(state);
    // pack_complete may now be reachable
    checkMetaAchievements(state);
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
    emitUnlock(def, 'meta');
  }

  if ((telemetry.currentStreak || 0) >= 7 && !state.unlocked['streak_7']) {
    const def = achievementMap.get('streak_7')!;
    state.unlocked['streak_7'] = {
      unlockedAt: new Date().toISOString(),
      group: 'meta',
    };
    state.xp += def.xp;
    newlyUnlocked.push(def);
    emitUnlock(def, 'meta');
  }

  if ((telemetry.currentStreak || 0) >= 30 && !state.unlocked['streak_30']) {
    const def = achievementMap.get('streak_30')!;
    state.unlocked['streak_30'] = {
      unlockedAt: new Date().toISOString(),
      group: 'meta',
    };
    state.xp += def.xp;
    newlyUnlocked.push(def);
    emitUnlock(def, 'meta');
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
