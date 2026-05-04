import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  MediaArtifact,
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
  ThreadInfo,
} from './types.js';
import type { DelegationRun } from './delegation/types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add description and trigger_scope columns (migration for triggered agents)
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN description TEXT`);
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN trigger_scope TEXT`,
    );
  } catch {
    /* columns already exist */
  }

  // Add subtitle column to registered_groups (agent-settable status line)
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN subtitle TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_system column to registered_groups (migration for system group flag)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_system INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }

  // Agent run usage tracking
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      session_id TEXT,
      timestamp TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      num_turns INTEGER DEFAULT 0,
      is_error INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_chat ON agent_runs(chat_jid);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_ts ON agent_runs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_group ON agent_runs(group_folder);
  `);

  // Add title column to scheduled_tasks (short display name)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN title TEXT`);
  } catch {
    /* column already exists */
  }

  // Add usage column to messages (migration for usage tracking on bot responses)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN usage TEXT`);
  } catch {
    /* column already exists */
  }

  // Add thread_id column to messages and threads table (migration for threaded conversations)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN thread_id TEXT`);
  } catch {
    /* column already exists */
  }

  // Add run_id column to messages (Phase 1 side panel: correlates a rendered
  // bot message back to the agent_runs row that produced it).
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN run_id INTEGER`);
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_messages_run_id ON messages(run_id)`,
    );
  } catch {
    /* column already exists */
  }

  // One-shot backfill: link pre-existing bot messages to their agent_runs row
  // by emulating what attachUsageToLastBotMessage does live — for each run in
  // chronological order, claim the most recent orphan bot message in the same
  // chat whose timestamp is ≤ the run's timestamp.
  const backfillDone = database
    .prepare(`SELECT value FROM router_state WHERE key = ?`)
    .get('migrated_run_id_backfill') as { value: string } | undefined;
  if (!backfillDone) {
    const runs = database
      .prepare(
        `SELECT rowid AS id, chat_jid, timestamp FROM agent_runs ORDER BY timestamp ASC`,
      )
      .all() as Array<{ id: number; chat_jid: string; timestamp: string }>;
    const claim = database.prepare(`
      UPDATE messages SET run_id = ?
      WHERE rowid = (
        SELECT rowid FROM messages
        WHERE chat_jid = ? AND is_bot_message = 1 AND run_id IS NULL
          AND timestamp <= ?
        ORDER BY timestamp DESC LIMIT 1
      )
    `);
    const tx = database.transaction((rows: typeof runs) => {
      for (const r of rows) claim.run(r.id, r.chat_jid, r.timestamp);
    });
    tx(runs);
    database
      .prepare(`INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)`)
      .run('migrated_run_id_backfill', new Date().toISOString());
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      thread_id TEXT PRIMARY KEY,
      agent_jid TEXT NOT NULL,
      origin_jid TEXT NOT NULL,
      agent_name TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
  `);

  // Add kind column to threads (Phase 2 side panel: distinguishes inline
  // trigger threads from side-drawer portal threads). 'trigger' = existing
  // web-all trigger reply chains (rendered inline by ThreadView), 'portal'
  // = delegation/action-button/agent-initiated side work (rendered in the
  // AgentPanel drawer).
  try {
    database.exec(`ALTER TABLE threads ADD COLUMN kind TEXT DEFAULT 'trigger'`);
  } catch {
    /* column already exists */
  }

  // Add title column to threads (fix for #100: concurrent portals to the
  // same specialist were ambiguous — both rendered as "Context Analyst"
  // with no way to tell them apart). Title is the task label — derived
  // from the button label, open_portal title, or delegation message.
  try {
    database.exec(`ALTER TABLE threads ADD COLUMN title TEXT`);
  } catch {
    /* column already exists */
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS media_artifacts (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      thread_id TEXT,
      created_at TEXT NOT NULL,
      source TEXT NOT NULL,
      media_type TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      path TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      agent_name TEXT,
      run_id TEXT,
      batch_id TEXT,
      caption TEXT,
      alt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_media_artifacts_chat ON media_artifacts(chat_jid, created_at);
  `);

  // Add tool_history column to agent_runs (per-run tool call chain for visibility)
  try {
    database.exec(`ALTER TABLE agent_runs ADD COLUMN tool_history TEXT`);
  } catch {
    /* column already exists */
  }

  // Add container_reuse column to agent_runs (warm pool telemetry)
  try {
    database.exec(
      `ALTER TABLE agent_runs ADD COLUMN container_reuse TEXT DEFAULT 'cold_start'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS delegation_runs (
      id TEXT PRIMARY KEY,
      parent_run_id TEXT,
      group_jid TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      coordinator_agent_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL,
      visibility TEXT NOT NULL,
      completion_policy TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      thread_id TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      result TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_delegation_runs_group ON delegation_runs(group_jid, created_at);
    CREATE INDEX IF NOT EXISTS idx_delegation_runs_batch ON delegation_runs(batch_id);
    CREATE INDEX IF NOT EXISTS idx_delegation_runs_thread ON delegation_runs(thread_id);
  `);
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  db.close();
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Map of chat_jid -> timestamp of the most recent message in that chat.
 * Queries the messages table directly because chats.last_message_time
 * isn't refreshed on every inbound web message. Used by the web UI to
 * sort groups by recent activity.
 */
export function getAllGroupLastActivity(): Record<string, string> {
  const rows = db
    .prepare(
      `SELECT chat_jid, MAX(timestamp) AS ts FROM messages GROUP BY chat_jid`,
    )
    .all() as Array<{ chat_jid: string; ts: string | null }>;
  const out: Record<string, string> = {};
  for (const r of rows) if (r.ts) out[r.chat_jid] = r.ts;
  return out;
}

/**
 * Map of group_folder -> earliest next_run across that group's active
 * scheduled tasks. Used by the web UI to sort groups by upcoming schedule.
 */
export function getAllGroupNextTaskAt(): Record<string, string> {
  const rows = db
    .prepare(
      `SELECT group_folder, MIN(next_run) AS next_run
       FROM scheduled_tasks
       WHERE status = 'active' AND next_run IS NOT NULL
       GROUP BY group_folder`,
    )
    .all() as Array<{ group_folder: string; next_run: string }>;
  const out: Record<string, string> = {};
  for (const r of rows) out[r.group_folder] = r.next_run;
  return out;
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.thread_id || null,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.thread_id || null,
  );
}

/** Update only the content of an existing message (preserves timestamp and rowid). */
export function updateMessageContent(
  id: string,
  chatJid: string,
  content: string,
): void {
  db.prepare(
    `UPDATE messages SET content = ? WHERE id = ? AND chat_jid = ?`,
  ).run(content, id, chatJid);
}

interface DelegationRunRow {
  id: string;
  parent_run_id: string | null;
  group_jid: string;
  group_folder: string;
  coordinator_agent_id: string;
  target_agent_id: string;
  message: string;
  status: DelegationRun['status'];
  visibility: DelegationRun['visibility'];
  completion_policy: DelegationRun['completionPolicy'];
  batch_id: string;
  thread_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  result: string | null;
  error: string | null;
}

function mapDelegationRun(row: DelegationRunRow): DelegationRun {
  return {
    id: row.id,
    parentRunId: row.parent_run_id || undefined,
    groupJid: row.group_jid,
    groupFolder: row.group_folder,
    coordinatorAgentId: row.coordinator_agent_id,
    targetAgentId: row.target_agent_id,
    message: row.message,
    status: row.status,
    visibility: row.visibility,
    completionPolicy: row.completion_policy,
    batchId: row.batch_id,
    threadId: row.thread_id || undefined,
    createdAt: row.created_at,
    startedAt: row.started_at || undefined,
    completedAt: row.completed_at || undefined,
    result: row.result || undefined,
    error: row.error || undefined,
  };
}

export function insertDelegationRun(run: DelegationRun): void {
  db.prepare(
    `
    INSERT INTO delegation_runs (
      id, parent_run_id, group_jid, group_folder, coordinator_agent_id,
      target_agent_id, message, status, visibility, completion_policy,
      batch_id, thread_id, created_at, started_at, completed_at, result, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    run.id,
    run.parentRunId || null,
    run.groupJid,
    run.groupFolder,
    run.coordinatorAgentId,
    run.targetAgentId,
    run.message,
    run.status,
    run.visibility,
    run.completionPolicy,
    run.batchId,
    run.threadId || null,
    run.createdAt,
    run.startedAt || null,
    run.completedAt || null,
    run.result || null,
    run.error || null,
  );
}

export function getDelegationRun(id: string): DelegationRun | undefined {
  const row = db
    .prepare(`SELECT * FROM delegation_runs WHERE id = ?`)
    .get(id) as DelegationRunRow | undefined;
  return row ? mapDelegationRun(row) : undefined;
}

export function listDelegationRunsForGroup(
  groupJid: string,
  limit: number = 50,
): DelegationRun[] {
  return db
    .prepare(
      `
      SELECT * FROM delegation_runs
      WHERE group_jid = ?
      ORDER BY created_at DESC
      LIMIT ?
    `,
    )
    .all(groupJid, limit)
    .map((row) => row as DelegationRunRow)
    .map(mapDelegationRun);
}

export function updateDelegationRun(
  id: string,
  patch: Partial<
    Pick<
      DelegationRun,
      'status' | 'startedAt' | 'completedAt' | 'result' | 'error'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  const fieldMap: Record<keyof typeof patch, string> = {
    status: 'status',
    startedAt: 'started_at',
    completedAt: 'completed_at',
    result: 'result',
    error: 'error',
  };

  for (const [key, value] of Object.entries(patch) as Array<
    [keyof typeof patch, unknown]
  >) {
    fields.push(`${fieldMap[key]} = ?`);
    values.push(value ?? null);
  }
  if (fields.length === 0) return;

  db.prepare(
    `UPDATE delegation_runs SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values, id);
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Exclude host-authored system notes; they are context artifacts, not
  // inbound work that should wake the message loop.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  // Exclude thread replies — they are routed via the queue, not the message loop
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND sender != 'system'
        AND thread_id IS NULL
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
  includeBotMessages: boolean = false,
  excludeThreaded: boolean = false,
  keepPortalThreads: boolean = false,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  // When includeBotMessages is true (e.g. web channel history), return all messages.
  const botFilter = includeBotMessages
    ? ''
    : 'AND is_bot_message = 0 AND content NOT LIKE ?';
  // Three filter modes:
  //   excludeThreaded=false                         → keep everything (default)
  //   excludeThreaded=true, keepPortalThreads=false → hide all threaded (UI main feed)
  //   excludeThreaded=true, keepPortalThreads=true  → hide trigger threads but keep
  //       portal-thread content so coordinators can see specialist output they
  //       delegated to. Without this, the coordinator would be blind to the
  //       work that happened in its own portals.
  let threadFilter = '';
  if (excludeThreaded) {
    threadFilter = keepPortalThreads
      ? `AND (thread_id IS NULL OR EXISTS (
           SELECT 1 FROM threads t
           WHERE t.thread_id = messages.thread_id AND t.kind = 'portal'
         ))`
      : 'AND thread_id IS NULL';
  }
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, thread_id, usage, run_id
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        ${botFilter}
        ${threadFilter}
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  const params = includeBotMessages
    ? [chatJid, sinceTimestamp, limit]
    : [chatJid, sinceTimestamp, `${botPrefix}:%`, limit];
  return db.prepare(sql).all(...params) as NewMessage[];
}

export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(timestamp) as ts FROM messages
       WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
    )
    .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
  return row?.ts ?? undefined;
}

// --- Thread accessors ---

export function createThread(
  threadId: string,
  agentJid: string,
  originJid: string,
  agentName?: string,
  kind: 'trigger' | 'portal' = 'trigger',
  title?: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO threads (thread_id, agent_jid, origin_jid, agent_name, created_at, kind, title) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    threadId,
    agentJid,
    originJid,
    agentName || null,
    new Date().toISOString(),
    kind,
    title || null,
  );
}

export function getThread(threadId: string): ThreadInfo | undefined {
  return db
    .prepare('SELECT * FROM threads WHERE thread_id = ?')
    .get(threadId) as ThreadInfo | undefined;
}

export function getAllThreads(): ThreadInfo[] {
  return db.prepare('SELECT * FROM threads').all() as ThreadInfo[];
}

export function getThreadMessages(
  threadId: string,
  limit: number = 50,
): NewMessage[] {
  return db
    .prepare(
      `SELECT m.id, m.chat_jid, m.sender, m.sender_name, m.content, m.timestamp, m.is_from_me, m.is_bot_message, m.thread_id
       FROM messages m
       JOIN threads t ON m.thread_id = t.thread_id
       WHERE m.thread_id = ? AND m.chat_jid = t.origin_jid
       ORDER BY m.timestamp
       LIMIT ?`,
    )
    .all(threadId, limit) as NewMessage[];
}

export function getThreadsForChat(chatJid: string): ThreadInfo[] {
  return db
    .prepare(
      `SELECT t.thread_id, t.agent_jid, t.origin_jid, t.agent_name, t.created_at, t.kind,
              COUNT(m.id) as reply_count
       FROM threads t
       LEFT JOIN messages m ON m.thread_id = t.thread_id AND m.chat_jid = ?
       WHERE t.origin_jid = ?
         AND (t.kind IS NULL OR t.kind = 'trigger')
       GROUP BY t.thread_id
       ORDER BY t.created_at DESC`,
    )
    .all(chatJid, chatJid) as ThreadInfo[];
}

/**
 * Portal (side-drawer) threads for a chat. Separate from trigger threads
 * so the inline ThreadView and drawer AgentPanel can each query only
 * what they render.
 */
export function getPortalThreadsForChat(chatJid: string): ThreadInfo[] {
  // Includes message count + preview of the last assistant reply + duration
  // (last_message_at - created_at) so the main-feed pill can render a
  // compact summary on page load without a follow-up fetch per portal.
  return db
    .prepare(
      `SELECT t.thread_id, t.agent_jid, t.origin_jid, t.agent_name, t.created_at, t.kind, t.title,
              COUNT(m.id) as reply_count,
              (SELECT content FROM messages
               WHERE thread_id = t.thread_id AND chat_jid = ?
                 AND is_bot_message = 1
               ORDER BY timestamp DESC LIMIT 1) as last_message_preview,
              (SELECT timestamp FROM messages
               WHERE thread_id = t.thread_id AND chat_jid = ?
               ORDER BY timestamp DESC LIMIT 1) as last_message_at
       FROM threads t
       LEFT JOIN messages m ON m.thread_id = t.thread_id AND m.chat_jid = ?
       WHERE t.origin_jid = ?
         AND t.kind = 'portal'
       GROUP BY t.thread_id
       ORDER BY t.created_at DESC`,
    )
    .all(chatJid, chatJid, chatJid, chatJid) as ThreadInfo[];
}

export function storeMediaArtifact(artifact: MediaArtifact): void {
  db.prepare(
    `INSERT OR REPLACE INTO media_artifacts
     (id, chat_jid, thread_id, created_at, source, media_type, mime_type, path, width, height, agent_name, run_id, batch_id, caption, alt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    artifact.id,
    artifact.chat_jid,
    artifact.thread_id || null,
    artifact.created_at,
    artifact.source,
    artifact.media_type,
    artifact.mime_type,
    artifact.path,
    artifact.width || null,
    artifact.height || null,
    artifact.agent_name || null,
    artifact.run_id || null,
    artifact.batch_id || null,
    artifact.caption || null,
    artifact.alt || null,
  );
}

export function getMediaArtifact(id: string): MediaArtifact | undefined {
  return db
    .prepare(
      `SELECT id, chat_jid, thread_id, created_at, source, media_type, mime_type, path, width, height, agent_name, run_id, batch_id, caption, alt
       FROM media_artifacts
       WHERE id = ?`,
    )
    .get(id) as MediaArtifact | undefined;
}

/**
 * Clear all messages (and associated threads) for a chat JID.
 * Preserves group registration, sessions, and tasks.
 */
export function clearMessages(chatJid: string): void {
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(chatJid);
    // Also clear messages copied to triggered agent JIDs from this chat
    db.prepare(
      `DELETE FROM messages WHERE chat_jid IN (SELECT agent_jid FROM threads WHERE origin_jid = ?)`,
    ).run(chatJid);
    db.prepare('DELETE FROM threads WHERE origin_jid = ?').run(chatJid);
  });
  txn();
}

export function deleteThreadsForGroup(jid: string): void {
  db.prepare('DELETE FROM threads WHERE origin_jid = ? OR agent_jid = ?').run(
    jid,
    jid,
  );
}

// A sentence is treated as role/identity preamble if it starts with one of
// these phrases. Such sentences describe *who* the agent is, not what the
// task does — useless as a title.
const ROLE_PREAMBLE_RE =
  /^(you are|you're|your (role|job|task|goal|responsibility) is|as (the|a|an)\b|i am|i'm)\b/i;

/** Generate a short display title from a task prompt. */
export function generateTaskTitle(prompt: string): string {
  const firstLine = prompt.split('\n')[0].trim();

  // Split into sentences and find the first non-preamble one.
  // Falls back to the first line if every sentence is preamble (e.g. an
  // identity-only prompt with no action).
  const sentences = firstLine
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const firstAction = sentences.find((s) => !ROLE_PREAMBLE_RE.test(s));
  const raw = firstAction || firstLine;

  // Drop any trailing punctuation left behind by the split, then strip
  // common prefixes that add no signal.
  const cleaned = raw
    .replace(/[.!?]+$/, '')
    .replace(/^\[.*?\]\s*/, '') // [SCHEDULED TASK]
    .replace(/^(please|can you|i want you to|every\s+\w+,?\s*)/i, '')
    .trim();

  const title = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return title.length > 60 ? title.slice(0, 57) + '...' : title;
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  const title = task.title || generateTaskTitle(task.prompt);
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, title, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    title,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'title'
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title || null);
  }
  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Task run logs ---

export function getTaskRunLogs(
  taskId: string,
  limit: number = 20,
): Array<{
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: string;
  result: string;
  error: string;
}> {
  return db
    .prepare(
      'SELECT * FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT ?',
    )
    .all(taskId, limit) as Array<{
    task_id: string;
    run_at: string;
    duration_ms: number;
    status: string;
    result: string;
    error: string;
  }>;
}

// --- Telemetry ---

export function getTelemetryStats(): {
  messages24h: number;
  messages7d: number;
  messagesPerGroup: Array<{ chat_jid: string; count: number }>;
  taskCounts: { active: number; paused: number; completed: number };
  taskSuccessRate: number;
  taskAvgDurationMs: number;
  totalTaskRuns: number;
  totalMessages: number;
  totalTasksCompleted: number;
  currentStreak: number;
} {
  const now = new Date();
  const h24 = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const messages24h = (
    db
      .prepare(
        'SELECT COUNT(*) as c FROM messages WHERE timestamp > ? AND is_bot_message = 0',
      )
      .get(h24) as { c: number }
  ).c;

  const messages7d = (
    db
      .prepare(
        'SELECT COUNT(*) as c FROM messages WHERE timestamp > ? AND is_bot_message = 0',
      )
      .get(d7) as { c: number }
  ).c;

  const messagesPerGroup = db
    .prepare(
      `SELECT chat_jid, COUNT(*) as count FROM messages
       WHERE timestamp > ? AND is_bot_message = 0
       GROUP BY chat_jid ORDER BY count DESC LIMIT 20`,
    )
    .all(h24) as Array<{ chat_jid: string; count: number }>;

  const taskCounts = (db
    .prepare(
      `SELECT
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) as paused,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
       FROM scheduled_tasks`,
    )
    .get() as { active: number; paused: number; completed: number }) || {
    active: 0,
    paused: 0,
    completed: 0,
  };

  const taskStats = (db
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes,
        AVG(duration_ms) as avg_duration
       FROM task_run_logs WHERE run_at > ?`,
    )
    .get(d7) as {
    total: number;
    successes: number;
    avg_duration: number | null;
  }) || { total: 0, successes: 0, avg_duration: null };

  // Gamification: all-time totals
  const totalMessages = (
    db
      .prepare('SELECT COUNT(*) as c FROM messages WHERE is_bot_message = 0')
      .get() as { c: number }
  ).c;

  const totalTasksCompleted = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM task_run_logs WHERE status = 'success'",
      )
      .get() as { c: number }
  ).c;

  // Streak: consecutive days (including today) with at least one user message
  let currentStreak = 0;
  const streakRows = db
    .prepare(
      `SELECT DISTINCT DATE(timestamp) as d FROM messages
       WHERE is_bot_message = 0
       ORDER BY d DESC LIMIT 60`,
    )
    .all() as Array<{ d: string }>;

  if (streakRows.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    let checkDate = today;
    for (const row of streakRows) {
      if (row.d === checkDate) {
        currentStreak++;
        // Move to previous day
        const prev = new Date(checkDate + 'T00:00:00');
        prev.setDate(prev.getDate() - 1);
        checkDate = prev.toISOString().slice(0, 10);
      } else {
        break;
      }
    }
  }

  return {
    messages24h,
    messages7d,
    messagesPerGroup,
    taskCounts: {
      active: taskCounts.active || 0,
      paused: taskCounts.paused || 0,
      completed: taskCounts.completed || 0,
    },
    taskSuccessRate:
      taskStats.total > 0 ? taskStats.successes / taskStats.total : 1,
    taskAvgDurationMs: taskStats.avg_duration || 0,
    totalTaskRuns: taskStats.total || 0,
    totalMessages,
    totalTasksCompleted,
    currentStreak,
  };
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
        description: string | null;
        trigger_scope: string | null;
        subtitle: string | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
    description: row.description || undefined,
    triggerScope:
      (row.trigger_scope as RegisteredGroup['triggerScope']) || undefined,
    subtitle: row.subtitle || undefined,
  };
}

export function setGroupSubtitle(jid: string, subtitle: string): void {
  db.prepare('UPDATE registered_groups SET subtitle = ? WHERE jid = ?').run(
    subtitle || null,
    jid,
  );
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main, description, trigger_scope, is_system)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
    group.description || null,
    group.triggerScope || null,
    group.isSystem ? 1 : 0,
  );
}

export function deleteGroupData(jid: string, folder: string): void {
  const txn = db.transaction(() => {
    // Delete task run logs for all tasks in this group
    db.prepare(
      `DELETE FROM task_run_logs WHERE task_id IN (SELECT id FROM scheduled_tasks WHERE group_folder = ?)`,
    ).run(folder);
    db.prepare('DELETE FROM scheduled_tasks WHERE group_folder = ?').run(
      folder,
    );
    db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(folder);
    db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
    db.prepare('DELETE FROM chats WHERE jid = ?').run(jid);
    db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
    deleteThreadsForGroup(jid);
  });
  txn();
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
    description: string | null;
    trigger_scope: string | null;
    is_system: number | null;
    subtitle: string | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
      isSystem: row.is_system === 1 ? true : undefined,
      description: row.description || undefined,
      triggerScope:
        (row.trigger_scope as RegisteredGroup['triggerScope']) || undefined,
      subtitle: row.subtitle || undefined,
    };
  }
  return result;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}

// --- Agent run usage tracking ---

export interface AgentRunRecord {
  chat_jid: string;
  group_folder: string;
  session_id?: string;
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  duration_ms: number;
  num_turns: number;
  is_error: boolean;
  tool_history?: string | null;
  container_reuse?: 'cold_start' | 'warm_reuse';
}

/**
 * Attach usage JSON (and optionally run_id) to the most recent bot message in a chat.
 * Called after storeAgentRun so the usage survives page refreshes.
 */
export function attachUsageToLastBotMessage(
  chatJid: string,
  usageJson: string,
  runId?: number,
): void {
  if (runId !== undefined) {
    db.prepare(
      `UPDATE messages SET usage = ?, run_id = ?
       WHERE rowid = (
         SELECT rowid FROM messages
         WHERE chat_jid = ? AND is_bot_message = 1
         ORDER BY timestamp DESC LIMIT 1
       )`,
    ).run(usageJson, runId, chatJid);
  } else {
    db.prepare(
      `UPDATE messages SET usage = ?
       WHERE rowid = (
         SELECT rowid FROM messages
         WHERE chat_jid = ? AND is_bot_message = 1
         ORDER BY timestamp DESC LIMIT 1
       )`,
    ).run(usageJson, chatJid);
  }
}

export function storeAgentRun(run: AgentRunRecord): number {
  const result = db
    .prepare(
      `INSERT INTO agent_runs (chat_jid, group_folder, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, num_turns, is_error, tool_history, container_reuse)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      run.chat_jid,
      run.group_folder,
      run.session_id || null,
      run.timestamp,
      run.input_tokens,
      run.output_tokens,
      run.cache_read_tokens,
      run.cache_write_tokens,
      run.cost_usd,
      run.duration_ms,
      run.num_turns,
      run.is_error ? 1 : 0,
      run.tool_history || null,
      run.container_reuse || 'cold_start',
    );
  return Number(result.lastInsertRowid);
}

export function getUsageStats(periodHours: number = 24): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalCostUsd: number;
  totalRuns: number;
  totalDurationMs: number;
  avgTurns: number;
  byGroup: Array<{
    group_folder: string;
    runs: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  }>;
  topTools: Array<{ tool: string; count: number }>;
} {
  const since = new Date(
    Date.now() - periodHours * 60 * 60 * 1000,
  ).toISOString();

  const totals = db
    .prepare(
      `SELECT
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
        COALESCE(SUM(cost_usd), 0) as cost_usd,
        COUNT(*) as runs,
        COALESCE(SUM(duration_ms), 0) as duration_ms,
        COALESCE(AVG(num_turns), 0) as avg_turns
       FROM agent_runs WHERE timestamp > ?`,
    )
    .get(since) as {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cost_usd: number;
    runs: number;
    duration_ms: number;
    avg_turns: number;
  };

  const byGroup = db
    .prepare(
      `SELECT group_folder,
        COUNT(*) as runs,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cost_usd), 0) as cost_usd
       FROM agent_runs WHERE timestamp > ?
       GROUP BY group_folder ORDER BY cost_usd DESC LIMIT 20`,
    )
    .all(since) as Array<{
    group_folder: string;
    runs: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  }>;

  // Aggregate tool call counts from stored tool_history JSON
  const toolRows = db
    .prepare(
      `SELECT tool_history FROM agent_runs WHERE timestamp > ? AND tool_history IS NOT NULL`,
    )
    .all(since) as Array<{ tool_history: string }>;

  const toolCounts: Record<string, number> = {};
  for (const row of toolRows) {
    try {
      const tools = JSON.parse(row.tool_history) as Array<{ tool: string }>;
      for (const t of tools) {
        toolCounts[t.tool] = (toolCounts[t.tool] || 0) + 1;
      }
    } catch {
      /* ignore malformed */
    }
  }

  const topTools = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([tool, count]) => ({ tool, count }));

  return {
    totalInputTokens: totals.input_tokens,
    totalOutputTokens: totals.output_tokens,
    totalCacheReadTokens: totals.cache_read_tokens,
    totalCacheWriteTokens: totals.cache_write_tokens,
    totalCostUsd: totals.cost_usd,
    totalRuns: totals.runs,
    totalDurationMs: totals.duration_ms,
    avgTurns: totals.avg_turns,
    byGroup,
    topTools,
  };
}

export interface SessionPressure {
  groupFolder: string;
  sessionId: string | null;
  turnCount: number;
  cumulativeCost: number;
  avgCostPerTurn: number;
  avgCacheWriteTokens: number;
  lastRunAt: string | null;
}

/**
 * Get session pressure metrics for a group's current session.
 * Aggregates cost and token data from the most recent session_id for the group.
 */
export function getSessionPressure(groupFolder: string): SessionPressure {
  const stats = db
    .prepare(
      `SELECT
        session_id,
        COUNT(*) as turn_count,
        COALESCE(SUM(cost_usd), 0) as cumulative_cost,
        COALESCE(AVG(cost_usd), 0) as avg_cost,
        COALESCE(AVG(cache_write_tokens), 0) as avg_cache_writes,
        MAX(timestamp) as last_run_at
       FROM agent_runs
       WHERE group_folder = ?
         AND session_id = (
           SELECT session_id FROM agent_runs
           WHERE group_folder = ? AND session_id IS NOT NULL
           ORDER BY timestamp DESC LIMIT 1
         )`,
    )
    .get(groupFolder, groupFolder) as
    | {
        session_id: string | null;
        turn_count: number;
        cumulative_cost: number;
        avg_cost: number;
        avg_cache_writes: number;
        last_run_at: string | null;
      }
    | undefined;

  if (!stats || stats.turn_count === 0) {
    return {
      groupFolder,
      sessionId: null,
      turnCount: 0,
      cumulativeCost: 0,
      avgCostPerTurn: 0,
      avgCacheWriteTokens: 0,
      lastRunAt: null,
    };
  }

  return {
    groupFolder,
    sessionId: stats.session_id,
    turnCount: stats.turn_count,
    cumulativeCost: stats.cumulative_cost,
    avgCostPerTurn: stats.avg_cost,
    avgCacheWriteTokens: stats.avg_cache_writes,
    lastRunAt: stats.last_run_at,
  };
}

/**
 * Get session pressure for all groups with runs in the last N hours.
 */
export function getAllSessionPressure(
  periodHours: number = 24,
): SessionPressure[] {
  const since = new Date(
    Date.now() - periodHours * 60 * 60 * 1000,
  ).toISOString();

  const groups = db
    .prepare(`SELECT DISTINCT group_folder FROM agent_runs WHERE timestamp > ?`)
    .all(since) as Array<{ group_folder: string }>;

  return groups
    .map((g) => getSessionPressure(g.group_folder))
    .filter((p) => p.turnCount > 0);
}

export function getLatestRunForChat(chatJid: string): AgentRunRecord | null {
  const row = db
    .prepare(
      'SELECT * FROM agent_runs WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT 1',
    )
    .get(chatJid) as
    | (Omit<AgentRunRecord, 'is_error'> & { is_error: number })
    | undefined;
  if (!row) return null;
  return { ...row, is_error: row.is_error === 1 };
}

export interface AgentRunRow extends AgentRunRecord {
  id: number;
}

/**
 * Get a single agent_runs row by rowid. Used by the side panel to slice the
 * transcript JSONL to a specific run's timestamp window.
 */
export function getAgentRunById(runId: number): AgentRunRow | null {
  const row = db
    .prepare('SELECT rowid as id, * FROM agent_runs WHERE rowid = ?')
    .get(runId) as
    | (Omit<AgentRunRow, 'is_error'> & { is_error: number })
    | undefined;
  if (!row) return null;
  return { ...row, is_error: row.is_error === 1 };
}

export interface SessionSummaryMessage {
  sender_name: string;
  content: string;
  timestamp: string;
  is_bot_message: boolean;
}

/**
 * Get recent messages for a session retrospective summary.
 * Returns a lightweight projection with truncated content.
 */
export function getSessionSummaryMessages(
  chatJid: string,
  limit: number = 20,
): SessionSummaryMessage[] {
  const rows = db
    .prepare(
      `SELECT sender_name, content, timestamp, is_bot_message
       FROM (
         SELECT sender_name, content, timestamp, is_bot_message
         FROM messages
         WHERE chat_jid = ?
           AND content != '' AND content IS NOT NULL
           AND thread_id IS NULL
         ORDER BY timestamp DESC
         LIMIT ?
       ) ORDER BY timestamp`,
    )
    .all(chatJid, limit) as Array<{
    sender_name: string | null;
    content: string;
    timestamp: string;
    is_bot_message: number;
  }>;

  return rows.map((r) => ({
    sender_name: r.sender_name || (r.is_bot_message ? 'Assistant' : 'User'),
    content:
      r.content.length > 200 ? r.content.slice(0, 200) + '...' : r.content,
    timestamp: r.timestamp,
    is_bot_message: r.is_bot_message === 1,
  }));
}
