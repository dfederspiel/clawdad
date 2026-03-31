import http from 'http';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import {
  getAchievementResponse,
  checkTelemetryAchievements,
  AchievementDef,
} from '../achievements.js';
import {
  DATA_DIR,
  GROUPS_DIR,
  WEB_UI_PORT,
  WEB_UI_ENABLED,
  ASSISTANT_NAME,
} from '../config.js';
import { getHealthStatus } from '../health.js';
import {
  getMessagesSince,
  storeMessageDirect,
  clearMessages,
  getAllTasks,
  getTaskById,
  getTaskRunLogs,
  createTask,
  updateTask,
  deleteTask,
  getTelemetryStats,
  getThreadsForChat,
  getThreadMessages,
  getUsageStats,
  getLatestRunForChat,
  getSession,
  setGroupSubtitle,
} from '../db.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
} from '../types.js';
import { computeNextRun } from '../task-scheduler.js';

// MIME types for static file serving
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// SSE client connections
interface SSEClient {
  res: http.ServerResponse;
  jid?: string; // optionally filter events to a specific group
}

export class WebChannel implements Channel {
  name = 'web';

  private server: http.Server | null = null;
  private sseClients: Map<string, SSEClient> = new Map();
  private opts: ChannelOpts;
  private webRoot: string;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
    // web/ directory is at project root
    this.webRoot = path.resolve(process.cwd(), 'web');

    // Wire up thread creation broadcast
    opts.onThreadCreated = (originJid, threadId, agentName) => {
      this.broadcast('thread_created', {
        jid: originJid,
        thread_id: threadId,
        agent_name: agentName,
      });
    };
  }

  async connect(): Promise<void> {
    // Auto-register a default web group if none exist yet.
    // This gives an out-of-box chat experience with no setup required.
    this.ensureDefaultGroup();

    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    return new Promise((resolve, reject) => {
      this.server!.listen(WEB_UI_PORT, () => {
        logger.info({ port: WEB_UI_PORT }, 'Web UI channel started');
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  /** Register a default web:general group as main if no web groups exist. */
  private ensureDefaultGroup(): void {
    const groups = this.opts.registeredGroups();
    const existingJid = Object.keys(groups).find((jid) =>
      jid.startsWith('web:'),
    );

    // If any web group exists, skip creating a default — but only restore
    // isSystem on the group that is actually marked as main.
    if (existingJid) {
      const mainJid = Object.keys(groups).find(
        (jid) => jid.startsWith('web:') && groups[jid].isMain,
      );
      if (mainJid && !groups[mainJid].isSystem) {
        groups[mainJid].isSystem = true;
      }
      return;
    }

    const jid = 'web:general';
    const group: RegisteredGroup = {
      name: 'General',
      folder: 'web_general',
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      isMain: true,
      isSystem: true,
    };
    this.opts.onRegisterGroup?.(jid, group);
    this.opts.onChatMetadata(
      jid,
      new Date().toISOString(),
      'ClawDad',
      'web',
      true,
    );
    logger.info('Auto-registered default web group (web:general) as main');
  }

  async disconnect(): Promise<void> {
    // Close all SSE connections
    for (const [id, client] of this.sseClients) {
      client.res.end();
      this.sseClients.delete(id);
    }
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
      logger.info('Web UI channel stopped');
    }
  }

  isConnected(): boolean {
    return this.server !== null && this.server.listening;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }

  async sendMessage(
    jid: string,
    text: string,
    threadId?: string,
  ): Promise<void> {
    const timestamp = new Date().toISOString();

    // Persist agent response so it survives page reloads
    storeMessageDirect({
      id: randomUUID(),
      chat_jid: jid,
      sender: ASSISTANT_NAME,
      sender_name: ASSISTANT_NAME,
      content: text,
      timestamp,
      is_from_me: true,
      is_bot_message: true,
      thread_id: threadId,
    });

    this.broadcast('message', { jid, text, timestamp, thread_id: threadId });
    logger.info({ jid, length: text.length, threadId }, 'Web message sent');
  }

  async setTyping(
    jid: string,
    isTyping: boolean,
    threadId?: string,
  ): Promise<void> {
    this.broadcast('typing', { jid, isTyping, thread_id: threadId });
  }

  /** Broadcast an achievement unlock to all connected clients. */
  broadcastAchievement(achievement: AchievementDef, group: string): void {
    this.broadcast('achievement', {
      id: achievement.id,
      name: achievement.name,
      description: achievement.description,
      tier: achievement.tier,
      xp: achievement.xp,
      group,
    });
  }

  broadcastGroupsChanged(): void {
    this.broadcast('groups_changed', {});
  }

  broadcastCredentialRequest(request: {
    service: string;
    hostPattern?: string;
    description?: string;
    email?: string;
    groupFolder: string;
  }): void {
    this.broadcast('credential_request', request);
  }

  broadcastAgentProgress(
    chatJid: string,
    event: { tool?: string; summary: string; timestamp: string },
  ): void {
    this.broadcast('agent_progress', { jid: chatJid, ...event });
  }

  broadcastUsageUpdate(
    chatJid: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      costUsd: number;
      durationMs: number;
      durationApiMs: number;
      numTurns: number;
    },
  ): void {
    this.broadcast('usage_update', { jid: chatJid, ...usage });
  }

  // --- HTTP Request Handler ---

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url || '/', `http://localhost:${WEB_UI_PORT}`);
    const method = req.method || 'GET';

    try {
      // API routes
      if (url.pathname.startsWith('/api/')) {
        return await this.handleApi(method, url, req, res);
      }

      // Static files from web/
      this.serveStatic(url.pathname, res);
    } catch (err) {
      logger.error({ err, path: url.pathname }, 'Web request error');
      this.json(res, 500, { error: 'Internal server error' });
    }
  }

  private async handleApi(
    method: string,
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // GET /api/events — SSE stream
    if (method === 'GET' && url.pathname === '/api/events') {
      return this.handleSSE(url, req, res);
    }

    // GET /api/groups — list web groups
    if (method === 'GET' && url.pathname === '/api/groups') {
      const allGroups = this.opts.registeredGroups();
      const webGroups = Object.entries(allGroups)
        .filter(([jid]) => jid.startsWith('web:'))
        .filter(([, g]) => g.triggerScope !== 'web-all') // Exclude triggered agents from sidebar
        .map(([jid, g]) => ({
          jid,
          name: g.name,
          folder: g.folder,
          isMain: g.isMain,
          isSystem: g.isSystem || false,
          subtitle: g.subtitle || '',
        }));
      return this.json(res, 200, { groups: webGroups });
    }

    // GET /api/triggers — list triggered agents for @-mention autocomplete
    if (method === 'GET' && url.pathname === '/api/triggers') {
      const allGroups = this.opts.registeredGroups();
      const triggers = Object.entries(allGroups)
        .filter(
          ([jid, g]) => jid.startsWith('web:') && g.triggerScope === 'web-all',
        )
        .map(([jid, g]) => ({
          jid,
          name: g.name,
          trigger: g.trigger,
          description: g.description || '',
        }));
      return this.json(res, 200, { triggers });
    }

    // GET /api/templates — list available group templates
    if (method === 'GET' && url.pathname === '/api/templates') {
      const seen = new Set<string>();
      const templates: {
        id: string;
        name: string;
        description: string;
        tier: string;
        triggerScope?: string;
        trigger?: string;
      }[] = [];

      // Helper: scan a directory for template folders with meta.json
      const scanDir = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory() || seen.has(entry.name)) continue;
          seen.add(entry.name);
          const metaPath = path.join(dir, entry.name, 'meta.json');
          let name = entry.name;
          let description = '';
          let tier = 'recipe';
          let triggerScope: string | undefined;
          let trigger: string | undefined;
          if (fs.existsSync(metaPath)) {
            try {
              const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
              name = meta.name || name;
              description = meta.description || '';
              tier = meta.tier || 'recipe';
              triggerScope = meta.triggerScope || undefined;
              trigger = meta.trigger || undefined;
            } catch {
              /* use defaults */
            }
          }
          templates.push({
            id: entry.name,
            name,
            description,
            tier,
            triggerScope,
            trigger,
          });
        }
      };

      // Read active pack from manifest, scan its templates
      const clawdoodlesDir = path.resolve(process.cwd(), 'clawdoodles');
      let activePack = 'starter';
      try {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(clawdoodlesDir, 'manifest.json'), 'utf-8'),
        );
        activePack = manifest.activePack || 'starter';
      } catch {
        /* use default */
      }
      scanDir(path.join(clawdoodlesDir, 'packs', activePack));

      return this.json(res, 200, { templates });
    }

    // GET /api/pack — active pack metadata (including setup fields)
    if (method === 'GET' && url.pathname === '/api/pack') {
      const clawdoodlesDir = path.resolve(process.cwd(), 'clawdoodles');
      let activePack = 'starter';
      try {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(clawdoodlesDir, 'manifest.json'), 'utf-8'),
        );
        activePack = manifest.activePack || 'starter';
      } catch {
        /* use default */
      }
      const packPath = path.join(
        clawdoodlesDir,
        'packs',
        activePack,
        'pack.json',
      );
      try {
        const pack = JSON.parse(fs.readFileSync(packPath, 'utf-8'));
        return this.json(res, 200, pack);
      } catch {
        return this.json(res, 200, { name: activePack, setup: [] });
      }
    }

    // GET /api/config — global user config
    if (method === 'GET' && url.pathname === '/api/config') {
      const configPath = path.join(GROUPS_DIR, 'global', 'user-config.json');
      if (fs.existsSync(configPath)) {
        try {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          return this.json(res, 200, config);
        } catch {
          return this.json(res, 200, {});
        }
      }
      return this.json(res, 200, {});
    }

    // POST /api/config — save global user config
    if (method === 'POST' && url.pathname === '/api/config') {
      const body = await this.readBody(req);
      const configDir = path.join(GROUPS_DIR, 'global');
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = path.join(configDir, 'user-config.json');
      fs.writeFileSync(configPath, JSON.stringify(body, null, 2) + '\n');
      logger.info('Global user config saved');
      return this.json(res, 200, { ok: true });
    }

    // POST /api/groups — register a new web group
    if (method === 'POST' && url.pathname === '/api/groups') {
      const body = await this.readBody(req);
      const { name, folder, template, description, triggerScope, trigger } =
        body;
      if (!name || !folder) {
        return this.json(res, 400, { error: 'name and folder are required' });
      }
      // Validate folder name (alphanumeric, underscores, dashes)
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(folder)) {
        return this.json(res, 400, {
          error:
            'folder must be alphanumeric with underscores/dashes, max 64 chars',
        });
      }
      const jid = `web:${folder}`;
      const existing = this.opts.registeredGroups();
      if (existing[jid]) {
        return this.json(res, 409, { error: 'Group already exists', jid });
      }
      const isTriggerAgent = triggerScope === 'web-all';
      const group: RegisteredGroup = {
        name,
        folder: `web_${folder}`,
        trigger: trigger || `@${name}`,
        added_at: new Date().toISOString(),
        requiresTrigger: isTriggerAgent ? true : false,
        description: description || undefined,
        triggerScope: isTriggerAgent ? 'web-all' : undefined,
      };

      // Copy template files BEFORE registration so the template CLAUDE.md
      // is in place before onRegisterGroup writes the default one.
      if (template) {
        const templateDir = this.resolveTemplateDir(template);
        if (templateDir && fs.existsSync(templateDir)) {
          const groupDir = path.resolve(process.cwd(), 'groups', group.folder);
          fs.mkdirSync(groupDir, { recursive: true });
          for (const file of fs.readdirSync(templateDir)) {
            const src = path.join(templateDir, file);
            const dst = path.join(groupDir, file);
            if (fs.statSync(src).isFile()) {
              fs.copyFileSync(src, dst);
            }
          }
        }
      }

      // Pre-fill agent-config.json with global user config (shared fields)
      const globalConfigPath = path.join(
        GROUPS_DIR,
        'global',
        'user-config.json',
      );
      if (fs.existsSync(globalConfigPath)) {
        try {
          const globalConfig = JSON.parse(
            fs.readFileSync(globalConfigPath, 'utf-8'),
          );
          const groupDir = path.resolve(process.cwd(), 'groups', group.folder);
          fs.mkdirSync(groupDir, { recursive: true });
          const agentConfigPath = path.join(groupDir, 'agent-config.json');

          // If template already created an agent-config, merge into it
          let agentConfig: Record<string, unknown> = {};
          if (fs.existsSync(agentConfigPath)) {
            try {
              agentConfig = JSON.parse(
                fs.readFileSync(agentConfigPath, 'utf-8'),
              );
            } catch {
              /* start fresh */
            }
          }

          // Merge all global config fields into agent-config.
          // Pack setup[] defines what to collect; templates define what to read.
          // The web channel is just a passthrough — no field-specific knowledge.
          for (const [key, value] of Object.entries(globalConfig)) {
            if (value != null && value !== '') {
              agentConfig[key] = value;
            }
          }

          fs.writeFileSync(
            agentConfigPath,
            JSON.stringify(agentConfig, null, 2) + '\n',
          );
        } catch (err) {
          logger.warn(
            { err },
            'Failed to pre-fill agent config from global config',
          );
        }
      }

      this.opts.onRegisterGroup?.(jid, group);
      // Store chat metadata
      this.opts.onChatMetadata(
        jid,
        new Date().toISOString(),
        name,
        'web',
        true,
      );
      return this.json(res, 201, { jid, group });
    }

    // DELETE /api/groups/:folder — delete a web group
    const deleteGroupMatch = url.pathname.match(
      /^\/api\/groups\/([A-Za-z0-9_-]+)$/,
    );
    if (method === 'DELETE' && deleteGroupMatch) {
      const folder = decodeURIComponent(deleteGroupMatch[1]);
      const jid = `web:${folder}`;
      const allGroups = this.opts.registeredGroups();
      const group = allGroups[jid];
      if (!group) {
        return this.json(res, 404, { error: 'Group not found' });
      }
      // Block deletion of system groups
      if (
        group.folder === 'main' ||
        group.folder === 'global' ||
        group.folder === 'web_general'
      ) {
        return this.json(res, 403, { error: 'Cannot delete system groups' });
      }
      this.opts.onDeleteGroup?.(jid, group);
      return this.json(res, 200, { ok: true });
    }

    // PATCH /api/groups/:folder — update group settings (name, subtitle)
    const patchGroupMatch = url.pathname.match(
      /^\/api\/groups\/([A-Za-z0-9_-]+)$/,
    );
    if (method === 'PATCH' && patchGroupMatch) {
      const folder = `web_${decodeURIComponent(patchGroupMatch[1])}`;
      const jid = `web:${decodeURIComponent(patchGroupMatch[1])}`;
      const allGroups = this.opts.registeredGroups();
      const group = allGroups[jid];
      if (!group) return this.json(res, 404, { error: 'Group not found' });

      const body = await this.readBody(req);
      if (body.subtitle !== undefined) {
        setGroupSubtitle(jid, body.subtitle);
        group.subtitle = body.subtitle || undefined;
      }
      this.broadcastGroupsChanged();
      return this.json(res, 200, { ok: true });
    }

    // GET /api/threads/:jid — threads for a chat with reply counts
    const threadsMatch = url.pathname.match(/^\/api\/threads\/(.+)$/);
    if (method === 'GET' && threadsMatch) {
      const jid = decodeURIComponent(threadsMatch[1]);
      const threads = getThreadsForChat(jid);
      return this.json(res, 200, { threads });
    }

    // GET /api/thread-messages/:threadId — messages in a thread
    const threadMsgsMatch = url.pathname.match(
      /^\/api\/thread-messages\/(.+)$/,
    );
    if (method === 'GET' && threadMsgsMatch) {
      const threadId = decodeURIComponent(threadMsgsMatch[1]);
      const messages = getThreadMessages(threadId);
      return this.json(res, 200, { messages });
    }

    // GET /api/messages/:jid — message history (excludes thread replies)
    const messagesMatch = url.pathname.match(/^\/api\/messages\/(.+)$/);
    if (method === 'GET' && messagesMatch) {
      const jid = decodeURIComponent(messagesMatch[1]);
      const since = url.searchParams.get('since') || '1970-01-01T00:00:00.000Z';
      const limit = parseInt(url.searchParams.get('limit') || '100', 10);
      const messages = getMessagesSince(
        jid,
        since,
        ASSISTANT_NAME,
        limit,
        true,
        true, // excludeThreaded — hide thread replies from main timeline
      );
      return this.json(res, 200, { messages });
    }

    // DELETE /api/messages/:jid — clear all messages (and threads) for a group
    if (method === 'DELETE' && messagesMatch) {
      const jid = decodeURIComponent(messagesMatch[1]);
      if (!jid.startsWith('web:')) {
        return this.json(res, 400, { error: 'jid must start with web:' });
      }
      clearMessages(jid);
      this.broadcast('messages_cleared', { jid });
      logger.info({ jid }, 'Messages cleared');
      return this.json(res, 200, { ok: true });
    }

    // POST /api/send — send a message to a web group (or thread reply)
    if (method === 'POST' && url.pathname === '/api/send') {
      const body = await this.readBody(req);
      const { jid, content, sender, thread_id } = body;
      if (!jid || !content) {
        return this.json(res, 400, { error: 'jid and content are required' });
      }
      if (content.length > 8000) {
        return this.json(res, 400, {
          error: 'Message too long (max 8000 chars)',
        });
      }
      if (!jid.startsWith('web:')) {
        return this.json(res, 400, { error: 'jid must start with web:' });
      }
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) {
        return this.json(res, 404, { error: 'Group not registered' });
      }

      const msg: NewMessage = {
        id: randomUUID(),
        chat_jid: jid,
        sender: sender || 'web-user',
        sender_name: sender || 'Web User',
        content,
        timestamp: new Date().toISOString(),
        is_from_me: false,
        is_bot_message: false,
        thread_id: thread_id || undefined,
      };

      if (thread_id) {
        // Thread reply: store in origin chat with thread_id, route to the thread's agent
        const storable = { ...msg, is_from_me: msg.is_from_me ?? false };
        storeMessageDirect(storable);
        // Copy to the thread's agent JID so it picks up the message
        const threadInfo = this.opts.getThreadInfo?.(thread_id);
        if (threadInfo) {
          storeMessageDirect({
            ...storable,
            id: `${msg.id}_thread_${threadInfo.agentJid}`,
            chat_jid: threadInfo.agentJid,
            thread_id: thread_id,
          });
          this.opts.onThreadReply?.(thread_id, threadInfo.agentJid);
        }
        // Broadcast to browsers for live update
        this.broadcast('user_message', { jid, message: msg });
      } else {
        // Normal message: deliver to orchestrator
        this.opts.onMessage(jid, msg);
        // Echo back to all connected browsers so the sender sees their message
        this.broadcast('user_message', { jid, message: msg });
      }

      return this.json(res, 200, { ok: true, messageId: msg.id });
    }

    // GET /api/status — container/queue status + uptime
    if (method === 'GET' && url.pathname === '/api/status') {
      const status = this.opts.getStatus?.() || {};
      return this.json(res, 200, status);
    }

    // GET /api/tasks — all scheduled tasks
    if (method === 'GET' && url.pathname === '/api/tasks') {
      return this.json(res, 200, { tasks: getAllTasks() });
    }

    // POST /api/tasks — create a scheduled task
    if (method === 'POST' && url.pathname === '/api/tasks') {
      const body = await this.readBody(req);
      const {
        group_folder,
        chat_jid,
        prompt,
        schedule_type,
        schedule_value,
        context_mode,
        script,
      } = body;
      if (
        !group_folder ||
        !chat_jid ||
        !prompt ||
        !schedule_type ||
        !schedule_value
      ) {
        return this.json(res, 400, {
          error:
            'group_folder, chat_jid, prompt, schedule_type, and schedule_value are required',
        });
      }
      if (!['cron', 'interval', 'once'].includes(schedule_type)) {
        return this.json(res, 400, {
          error: 'schedule_type must be cron, interval, or once',
        });
      }
      const task: Omit<ScheduledTask, 'last_run' | 'last_result'> = {
        id: randomUUID(),
        group_folder,
        chat_jid,
        prompt,
        script: script || null,
        schedule_type: schedule_type as ScheduledTask['schedule_type'],
        schedule_value,
        context_mode:
          (context_mode as ScheduledTask['context_mode']) || 'isolated',
        next_run: null,
        status: 'active',
        created_at: new Date().toISOString(),
      };
      // Compute first next_run
      const fullTask = {
        ...task,
        last_run: null,
        last_result: null,
      } as ScheduledTask;
      task.next_run = computeNextRun(fullTask);
      createTask(task);
      return this.json(res, 201, {
        task: { ...task, last_run: null, last_result: null },
      });
    }

    // GET /api/tasks/:id/logs — execution history for a task
    const taskLogsMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/logs$/);
    if (method === 'GET' && taskLogsMatch) {
      const taskId = decodeURIComponent(taskLogsMatch[1]);
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      return this.json(res, 200, { logs: getTaskRunLogs(taskId, limit) });
    }

    // POST /api/tasks/:id/pause — pause a task
    const taskPauseMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/pause$/);
    if (method === 'POST' && taskPauseMatch) {
      const taskId = decodeURIComponent(taskPauseMatch[1]);
      const task = getTaskById(taskId);
      if (!task) return this.json(res, 404, { error: 'Task not found' });
      updateTask(taskId, { status: 'paused' });
      return this.json(res, 200, { ok: true });
    }

    // POST /api/tasks/:id/resume — resume a task
    const taskResumeMatch = url.pathname.match(
      /^\/api\/tasks\/([^/]+)\/resume$/,
    );
    if (method === 'POST' && taskResumeMatch) {
      const taskId = decodeURIComponent(taskResumeMatch[1]);
      const task = getTaskById(taskId);
      if (!task) return this.json(res, 404, { error: 'Task not found' });
      updateTask(taskId, { status: 'active' });
      return this.json(res, 200, { ok: true });
    }

    // DELETE /api/tasks/:id — cancel/delete a task
    const taskDeleteMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (method === 'DELETE' && taskDeleteMatch) {
      const taskId = decodeURIComponent(taskDeleteMatch[1]);
      const task = getTaskById(taskId);
      if (!task) return this.json(res, 404, { error: 'Task not found' });
      deleteTask(taskId);
      return this.json(res, 200, { ok: true });
    }

    // GET /api/transcript?group=folder — parse the session transcript for a group
    if (method === 'GET' && url.pathname === '/api/transcript') {
      const folder = url.searchParams.get('group');
      if (!folder) return this.json(res, 400, { error: 'group required' });

      const sessionId = getSession(folder);
      if (!sessionId) {
        return this.json(res, 404, { error: 'No active session' });
      }

      // Find transcript JSONL — try common project paths
      const sessionsBase = path.join(
        DATA_DIR,
        'sessions',
        folder,
        '.claude',
        'projects',
      );
      let transcriptPath: string | null = null;
      if (fs.existsSync(sessionsBase)) {
        const findJsonl = (dir: string): string | null => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isFile() && entry.name === `${sessionId}.jsonl`)
              return full;
            if (entry.isDirectory() && entry.name !== 'subagents') {
              const found = findJsonl(full);
              if (found) return found;
            }
          }
          return null;
        };
        transcriptPath = findJsonl(sessionsBase);
      }

      if (!transcriptPath || !fs.existsSync(transcriptPath)) {
        return this.json(res, 404, { error: 'Transcript not found' });
      }

      try {
        const content = fs.readFileSync(transcriptPath, 'utf-8');
        const entries = content
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter(Boolean);

        // Parse into a simplified timeline
        const timeline: Array<{
          type: string;
          role?: string;
          tool?: string;
          summary?: string;
          content?: string;
          timestamp?: string;
        }> = [];

        for (const entry of entries) {
          if (entry.type === 'assistant' && entry.message?.content) {
            for (const block of entry.message.content) {
              if (block.type === 'text' && block.text) {
                timeline.push({
                  type: 'text',
                  role: 'assistant',
                  content: block.text.slice(0, 2000),
                  timestamp: entry.timestamp,
                });
              }
              if (block.type === 'tool_use') {
                const summary = block.input?.command
                  ? String(block.input.command).split('\n')[0].slice(0, 120)
                  : block.input?.file_path
                    ? String(block.input.file_path).split(/[/\\]/).pop()
                    : block.input?.pattern
                      ? String(block.input.pattern).slice(0, 80)
                      : '';
                timeline.push({
                  type: 'tool_use',
                  tool: block.name,
                  summary,
                  timestamp: entry.timestamp,
                });
              }
              if (block.type === 'tool_result') {
                timeline.push({
                  type: 'tool_result',
                  tool: block.name,
                  content:
                    typeof block.content === 'string'
                      ? block.content.slice(0, 500)
                      : '',
                  timestamp: entry.timestamp,
                });
              }
            }
          }
          if (entry.type === 'user' && entry.message?.content) {
            const text =
              typeof entry.message.content === 'string'
                ? entry.message.content
                : Array.isArray(entry.message.content)
                  ? entry.message.content
                      .filter(
                        (b: { type: string; text?: string }) =>
                          b.type === 'text',
                      )
                      .map((b: { text: string }) => b.text)
                      .join('')
                  : '';
            if (text) {
              timeline.push({
                type: 'text',
                role: 'user',
                content: text.slice(0, 2000),
                timestamp: entry.timestamp,
              });
            }
          }
        }

        return this.json(res, 200, { sessionId, timeline });
      } catch (err) {
        logger.error({ err, folder }, 'Failed to parse transcript');
        return this.json(res, 500, { error: 'Failed to parse transcript' });
      }
    }

    // GET /api/usage — token and cost usage metrics
    if (method === 'GET' && url.pathname === '/api/usage') {
      const hours = parseInt(url.searchParams.get('hours') || '24', 10);
      const usage = getUsageStats(hours);
      return this.json(res, 200, usage);
    }

    // GET /api/usage/latest?jid=... — latest run for a specific chat
    if (method === 'GET' && url.pathname === '/api/usage/latest') {
      const jid = url.searchParams.get('jid');
      if (!jid) return this.json(res, 400, { error: 'jid required' });
      const run = getLatestRunForChat(jid);
      return this.json(res, 200, { run });
    }

    // GET /api/telemetry — aggregated metrics
    if (method === 'GET' && url.pathname === '/api/telemetry') {
      const stats = getTelemetryStats();

      // Check telemetry-based achievements (centurion, streaks)
      const newAchievements = checkTelemetryAchievements(stats);
      for (const ach of newAchievements) {
        this.broadcast('achievement', {
          id: ach.id,
          name: ach.name,
          description: ach.description,
          tier: ach.tier,
          xp: ach.xp,
        });
      }

      return this.json(res, 200, stats);
    }

    // GET /api/achievements — achievement definitions + unlock state
    if (method === 'GET' && url.pathname === '/api/achievements') {
      return this.json(res, 200, getAchievementResponse());
    }

    // GET /api/health — prerequisite check for first-boot onboarding
    if (method === 'GET' && url.pathname === '/api/health') {
      const health = await getHealthStatus();
      return this.json(res, 200, health);
    }

    // POST /api/register-anthropic — register Anthropic API key via OneCLI
    if (method === 'POST' && url.pathname === '/api/register-anthropic') {
      // Localhost only — refuse remote requests
      const remote = req.socket.remoteAddress;
      if (
        remote !== '127.0.0.1' &&
        remote !== '::1' &&
        remote !== '::ffff:127.0.0.1'
      ) {
        return this.json(res, 403, { error: 'Localhost only' });
      }

      const body = await this.readBody(req);
      const { key, customEndpoint } = body;
      if (!key) {
        return this.json(res, 400, { error: 'key is required' });
      }

      try {
        const hostPattern = customEndpoint
          ? new URL(customEndpoint).hostname
          : 'api.anthropic.com';

        // Pass key via stdin to avoid it appearing in process args
        execSync(
          `onecli secrets create --name anthropic --type anthropic --host-pattern "${hostPattern}"`,
          {
            input: key,
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 10000,
          },
        );

        // Write custom endpoint to .env if provided
        if (customEndpoint) {
          const envPath = path.resolve(process.cwd(), '.env');
          let envContent = '';
          if (fs.existsSync(envPath)) {
            envContent = fs.readFileSync(envPath, 'utf-8');
          }
          if (envContent.includes('ANTHROPIC_BASE_URL=')) {
            envContent = envContent.replace(
              /^ANTHROPIC_BASE_URL=.*$/m,
              `ANTHROPIC_BASE_URL=${customEndpoint}`,
            );
          } else {
            envContent += `\nANTHROPIC_BASE_URL=${customEndpoint}\n`;
          }
          fs.writeFileSync(envPath, envContent);
        }

        logger.info('Anthropic API key registered via web UI');
        return this.json(res, 200, { ok: true });
      } catch (err) {
        logger.error({ err }, 'Failed to register Anthropic key');
        return this.json(res, 500, {
          error: 'Failed to register key. Is OneCLI running?',
        });
      }
    }

    // POST /api/register-credential — register any credential via IPC→OneCLI
    // Used by the CredentialModal when an agent requests a credential via popup
    if (method === 'POST' && url.pathname === '/api/register-credential') {
      const remote = req.socket.remoteAddress;
      if (
        remote !== '127.0.0.1' &&
        remote !== '::1' &&
        remote !== '::ffff:127.0.0.1'
      ) {
        return this.json(res, 403, { error: 'Localhost only' });
      }

      const body = await this.readBody(req);
      const { service, key, email, hostPattern, groupFolder } = body;
      if (!service || !key) {
        return this.json(res, 400, {
          error: 'service and key are required',
        });
      }

      // Write to IPC credentials dir — the existing IPC poll loop
      // picks it up, runs OneCLI, and writes the result file
      const targetFolder = groupFolder || 'web_general';
      const credDir = path.join(DATA_DIR, 'ipc', targetFolder, 'credentials');
      fs.mkdirSync(credDir, { recursive: true });

      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
      const filepath = path.join(credDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(
        tempPath,
        JSON.stringify({
          service,
          value: key,
          email: email || undefined,
          hostPattern: hostPattern || undefined,
        }),
      );
      fs.renameSync(tempPath, filepath);

      logger.info(
        { service, groupFolder: targetFolder },
        'Credential registration requested via web UI',
      );
      return this.json(res, 200, { ok: true });
    }

    this.json(res, 404, { error: 'Not found' });
  }

  // --- SSE ---

  private handleSSE(
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const clientId = url.searchParams.get('clientId') || randomUUID();
    const jidFilter = url.searchParams.get('jid') || undefined;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');

    this.sseClients.set(clientId, { res, jid: jidFilter });

    // Keepalive
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 30000);

    req.on('close', () => {
      clearInterval(keepalive);
      this.sseClients.delete(clientId);
    });
  }

  private broadcast(event: string, data: Record<string, unknown>): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients.values()) {
      // If client has a JID filter, only send matching events
      if (client.jid && data.jid && client.jid !== data.jid) continue;
      client.res.write(payload);
    }
  }

  // --- Static File Serving ---

  private serveStatic(pathname: string, res: http.ServerResponse): void {
    if (pathname === '/') pathname = '/index.html';

    const filePath = path.join(this.webRoot, pathname);

    // Prevent directory traversal
    if (!filePath.startsWith(this.webRoot)) {
      this.json(res, 403, { error: 'Forbidden' });
      return;
    }

    try {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
      });
      res.end(content);
    } catch {
      this.json(res, 404, { error: 'Not found' });
    }
  }

  // --- Helpers ---

  /** Resolve a template ID to its directory in the active pack. */
  private resolveTemplateDir(template: string): string | null {
    if (!/^[a-z0-9-]+$/.test(template)) return null;
    const clawdoodlesDir = path.resolve(process.cwd(), 'clawdoodles');
    let activePack = 'starter';
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(clawdoodlesDir, 'manifest.json'), 'utf-8'),
      );
      activePack = manifest.activePack || 'starter';
    } catch {
      /* use default */
    }
    const dir = path.join(clawdoodlesDir, 'packs', activePack, template);
    return fs.existsSync(dir) ? dir : null;
  }

  private json(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private readBody(
    req: http.IncomingMessage,
    maxBytes: number = 16384,
  ): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      let body = '';
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          reject(new Error('Request body too large'));
          return;
        }
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }
}

// Self-register the web channel
registerChannel('web', (opts: ChannelOpts) => {
  if (!WEB_UI_ENABLED) {
    logger.info('Web UI: disabled (set WEB_UI_ENABLED=true in .env to enable)');
    return null;
  }
  return new WebChannel(opts);
});
