import http from 'http';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import {
  DEFAULT_AGENT_NAME,
  discoverAgents,
  resolveAgentClaudeMdPath,
} from '../agent-discovery.js';
import {
  compareRuntimeProfiles,
  resolveRuntimeProfile,
} from '../runtime-profile.js';
import { getCapabilityProfile } from '../model-capabilities.js';
import { resolveEffectiveRuntime } from '../runtime-resolution.js';
import { listAvailableTools, listToolsForRuntime } from '../tool-registry.js';
import { computeXp, levelFromXp } from '../xp.js';
import type { AgentRuntimeConfig, RuntimeProvider } from '../runtime-types.js';
import {
  getAchievementResponse,
  checkTelemetryAchievements,
  AchievementDef,
} from '../achievements.js';
import { getActiveAgentName } from '../agent-state.js';
import {
  DATA_DIR,
  GROUPS_DIR,
  WEB_UI_PORT,
  WEB_UI_ENABLED,
  ASSISTANT_NAME,
} from '../config.js';
import { getHealthStatus } from '../health.js';
import {
  getProviderAuthHealth,
  recheckProviderAuth,
  resolveAnthropicCredentials,
} from '../provider-auth.js';
import {
  getAllGroupLastActivity,
  getAllGroupNextTaskAt,
  getBlockStateForMessages,
  getMessagesSince,
  getMessageById,
  getMediaArtifact,
  createPinThread,
  getPinsForChat,
  getPinByThreadId,
  deletePinThread,
  storeMediaArtifact,
  storeMessageDirect,
  updateMessageContent,
  clearMessages,
  deleteMessage,
  getAllTasks,
  getTaskById,
  getTaskRunLogs,
  createTask,
  updateTask,
  deleteTask,
  getTelemetryStats,
  getThreadsForChat,
  getPortalThreadsForChat,
  getThreadMessages,
  getUsageStats,
  getLatestRunForChat,
  getAgentRunById,
  getSession,
  getSessionPressure,
  getAllSessionPressure,
  setGroupSubtitle,
  getSessionSummaryMessages,
} from '../db.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  MediaArtifact,
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
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

// SSE client connections
interface SSEClient {
  res: http.ServerResponse;
  jid?: string; // optionally filter events to a specific group
}

// Module-level cache for /api/models. The upstream model list rarely
// changes; a short TTL keeps the picker snappy without hammering the
// gateway. Errors get a shorter TTL so a fixed config recovers quickly.
const UPSTREAM_MODELS_TTL_MS = 5 * 60_000;
let upstreamModelsCache: {
  payload: Record<string, unknown>;
  expires: number;
} | null = null;

function readUpstreamModelsCache(): Record<string, unknown> | null {
  if (!upstreamModelsCache) return null;
  if (Date.now() > upstreamModelsCache.expires) {
    upstreamModelsCache = null;
    return null;
  }
  return upstreamModelsCache.payload;
}

function writeUpstreamModelsCache(
  payload: Record<string, unknown>,
  ttlMs: number = UPSTREAM_MODELS_TTL_MS,
): void {
  upstreamModelsCache = { payload, expires: Date.now() + ttlMs };
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
    // Portal (side-drawer) thread opening — distinct event so the client
    // can auto-open the drawer instead of rendering inline like trigger threads.
    opts.onThreadOpened = (
      originJid,
      threadId,
      agentName,
      kind,
      sourceAgent,
      title,
    ) => {
      this.broadcast('thread_opened', {
        jid: originJid,
        thread_id: threadId,
        agent_name: agentName,
        kind,
        source_agent: sourceAgent,
        title,
      });
    };
    // Portal thread completion — client clears the `live` flag so the
    // portal drops out of the drawer's live stack.
    opts.onThreadClosed = (originJid, threadId) => {
      this.broadcast('thread_closed', {
        jid: originJid,
        thread_id: threadId,
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
    explicitSenderName?: string,
  ): Promise<string> {
    const id = randomUUID();
    const timestamp = new Date().toISOString();

    // Prefer the explicit param (race-free) — fall back to the active-agent
    // slot for callers that haven't been updated, then to the default.
    const senderName =
      explicitSenderName || getActiveAgentName(jid) || ASSISTANT_NAME;

    // Persist agent response so it survives page reloads
    storeMessageDirect({
      id,
      chat_jid: jid,
      sender: senderName,
      sender_name: senderName,
      content: text,
      timestamp,
      is_from_me: true,
      is_bot_message: true,
      thread_id: threadId,
    });

    this.broadcast('message', {
      jid,
      message_id: id,
      text,
      timestamp,
      thread_id: threadId,
      sender_name: senderName,
    });
    logger.info({ jid, length: text.length, threadId }, 'Web message sent');
    return id;
  }

  publishMediaMessage(
    jid: string,
    artifact: MediaArtifact,
    senderName?: string,
  ): string {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const effectiveSender =
      senderName || getActiveAgentName(jid) || ASSISTANT_NAME;
    const text = this.buildMediaMessageContent(artifact);

    storeMessageDirect({
      id,
      chat_jid: jid,
      sender: effectiveSender,
      sender_name: effectiveSender,
      content: text,
      timestamp,
      is_from_me: true,
      is_bot_message: true,
      thread_id: artifact.thread_id,
    });

    this.broadcast('message', {
      jid,
      message_id: id,
      text,
      timestamp,
      thread_id: artifact.thread_id,
      sender_name: effectiveSender,
    });

    logger.info(
      { jid, artifactId: artifact.id, threadId: artifact.thread_id },
      'Web media message sent',
    );
    return id;
  }

  async updateMessage(
    jid: string,
    messageId: string,
    text: string,
    _threadId?: string,
  ): Promise<void> {
    const senderName = getActiveAgentName(jid) || ASSISTANT_NAME;

    // Update content only — preserve original timestamp and rowid so
    // message order stays stable on page refresh.
    updateMessageContent(messageId, jid, text);

    this.broadcast('message_update', {
      jid,
      message_id: messageId,
      text,
      sender_name: senderName,
    });
  }

  async setTyping(
    jid: string,
    isTyping: boolean,
    threadId?: string,
    agentName?: string,
    instanceId?: string,
  ): Promise<void> {
    const name = agentName || getActiveAgentName(jid);
    this.broadcast('typing', {
      jid,
      isTyping,
      thread_id: threadId,
      agent_name: name,
      instance_id: instanceId,
    });
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

  /**
   * Surface a small XP gain so the HUD can float a "+N XP" indicator at
   * the moment of the action that earned it. Idle-loop refreshes still
   * reconcile the total — this is the dopamine signal, not the source
   * of truth.
   */
  broadcastXpGain(event: {
    delta: number;
    source: 'user_message' | 'agent_reply' | 'task_run';
    jid?: string;
  }): void {
    this.broadcast('xp_gain', {
      delta: event.delta,
      source: event.source,
      jid: event.jid,
      ts: Date.now(),
    });
  }

  /** Surface a scheduled-task failure to the notification bell + sidebar. */
  broadcastTaskFailed(event: {
    taskId: string;
    taskTitle: string;
    groupFolder: string;
    groupName: string;
    chatJid: string;
    error: string;
    runAt: string;
  }): void {
    this.broadcast('task_failed', {
      task_id: event.taskId,
      task_title: event.taskTitle,
      group_folder: event.groupFolder,
      group_name: event.groupName,
      jid: event.chatJid,
      error: event.error,
      run_at: event.runAt,
    });
  }

  private sanitizeAgentName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  }

  private getGroupDir(folder: string): string {
    return path.resolve(process.cwd(), 'groups', folder);
  }

  private readJsonFile(filePath: string): Record<string, unknown> {
    if (!fs.existsSync(filePath)) return {};
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return {};
    }
  }

  private buildMediaMessageContent(
    artifact: MediaArtifact,
    options?: { fileLabel?: string; agentPath?: string },
  ): string {
    const lines: string[] = [];
    if (options?.fileLabel)
      lines.push(`Uploaded image \`${options.fileLabel}\`.`);
    if (options?.agentPath) {
      lines.push(`File available to agents at \`${options.agentPath}\`.`);
    }
    if (lines.length > 0) lines.push('');
    lines.push(
      ':::blocks',
      JSON.stringify(
        [
          {
            type: 'image',
            artifactId: artifact.id,
            src: `/api/media/${artifact.id}`,
            alt:
              artifact.alt ||
              artifact.caption ||
              options?.fileLabel ||
              'Uploaded image',
            caption: artifact.caption || '',
          },
        ],
        null,
        2,
      ),
      ':::',
    );
    return lines.join('\n');
  }

  private refreshAgentsAndRespond(res: http.ServerResponse, jid: string): void {
    const agents = this.opts.refreshGroupAgents?.(jid) || [];
    this.broadcastGroupsChanged();
    this.json(res, 200, { ok: true, agents });
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
    threadId?: string,
    agentName?: string,
    instanceId?: string,
  ): void {
    // Prefer the explicit per-call agentName; falling back to the global
    // slot races across parallel instances of the same agent (#130).
    const name = agentName || getActiveAgentName(chatJid);
    this.broadcast('agent_progress', {
      jid: chatJid,
      ...event,
      agent_name: name,
      thread_id: threadId,
      instance_id: instanceId,
    });
  }

  broadcastWorkState(event: import('../types.js').WorkStateEvent): void {
    this.broadcast('work_state', event as unknown as Record<string, unknown>);
  }

  // #141 — Pushed when an agent's update_block call lands.
  broadcastBlockStateUpdate(payload: {
    jid: string;
    message_id: string;
    block_id: string;
    state: Record<string, unknown>;
    updated_at: string;
    updated_by?: string | null;
  }): void {
    this.broadcast('block_state_update', payload);
  }

  // #142 — Pinned surfaces lifecycle. Dedicated events keep pins out of
  // the existing thread_created/thread_closed pipeline (which is wired
  // for portal auto-open behavior we don't want for pins).
  broadcastPinCreated(payload: {
    jid: string;
    thread_id: string;
    message_id: string;
    block_id: string | null;
    title: string | null;
    created_at: string;
  }): void {
    this.broadcast('pin_created', payload);
  }

  broadcastPinRemoved(payload: { jid: string; thread_id: string }): void {
    this.broadcast('pin_removed', payload);
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
    runId?: number,
  ): void {
    this.broadcast('usage_update', {
      jid: chatJid,
      ...usage,
      run_id: runId,
    });
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
      const lastActivity = getAllGroupLastActivity();
      const nextTaskAt = getAllGroupNextTaskAt();
      const webGroups = Object.entries(allGroups)
        .filter(([jid]) => jid.startsWith('web:'))
        // Exclude trigger-only agents (requiresTrigger + web-all) from sidebar.
        // Agents with web-all scope but requiresTrigger=false appear in both.
        .filter(
          ([, g]) =>
            g.triggerScope !== 'web-all' || g.requiresTrigger === false,
        )
        .map(([jid, g]) => ({
          jid,
          name: g.name,
          folder: g.folder,
          isMain: g.isMain,
          isSystem: g.isSystem || false,
          subtitle: g.subtitle || '',
          lastActivity: lastActivity[jid] || null,
          nextTaskAt: nextTaskAt[g.folder] || null,
          agents: this.opts.getGroupAgents?.(jid) || [],
        }));
      return this.json(res, 200, { groups: webGroups });
    }

    const mediaMatch = url.pathname.match(/^\/api\/media\/([A-Za-z0-9_-]+)$/);
    if (method === 'GET' && mediaMatch) {
      const artifact = getMediaArtifact(mediaMatch[1]);
      if (!artifact || !fs.existsSync(artifact.path)) {
        return this.json(res, 404, { error: 'Media not found' });
      }

      res.writeHead(200, {
        'Content-Type': artifact.mime_type,
        'Cache-Control': 'private, max-age=3600',
      });
      fs.createReadStream(artifact.path).pipe(res);
      return;
    }

    if (method === 'POST' && url.pathname === '/api/upload-media') {
      const body = await this.readBody(req, 15 * 1024 * 1024);
      const { jid, thread_id, filename, mime_type, data_base64, caption } =
        body;
      if (!jid || !filename || !mime_type || !data_base64) {
        return this.json(res, 400, {
          error: 'jid, filename, mime_type, and data_base64 are required',
        });
      }
      if (!jid.startsWith('web:')) {
        return this.json(res, 400, { error: 'jid must start with web:' });
      }
      const group = this.opts.registeredGroups()[jid];
      if (!group) {
        return this.json(res, 404, { error: 'Group not registered' });
      }
      if (!String(mime_type).startsWith('image/')) {
        return this.json(res, 400, {
          error: 'Only image uploads are supported',
        });
      }

      const mimeToExt: Record<string, string> = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/gif': '.gif',
        'image/webp': '.webp',
      };
      const ext =
        mimeToExt[String(mime_type)] ||
        path.extname(String(filename)).toLowerCase() ||
        '.bin';
      if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
        return this.json(res, 400, { error: 'Unsupported image type' });
      }

      let buffer: Buffer;
      try {
        buffer = Buffer.from(String(data_base64), 'base64');
      } catch {
        return this.json(res, 400, { error: 'Invalid base64 payload' });
      }
      if (buffer.length === 0) {
        return this.json(res, 400, { error: 'Empty image payload' });
      }

      const artifactId = randomUUID();
      const safeChatDir = jid.replace(/[^a-zA-Z0-9:_-]/g, '_');
      const mediaDir = path.join(DATA_DIR, 'media', safeChatDir);
      fs.mkdirSync(mediaDir, { recursive: true });
      const storedMediaPath = path.join(mediaDir, `${artifactId}${ext}`);
      fs.writeFileSync(storedMediaPath, buffer);

      const groupDir = this.getGroupDir(group.folder);
      const uploadsDir = path.join(groupDir, 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });
      const agentFileName = `upload-${artifactId}${ext}`;
      const agentHostPath = path.join(uploadsDir, agentFileName);
      fs.writeFileSync(agentHostPath, buffer);
      const agentPath = `/workspace/group/uploads/${agentFileName}`;

      const artifact: MediaArtifact = {
        id: artifactId,
        chat_jid: jid,
        thread_id: thread_id || undefined,
        created_at: new Date().toISOString(),
        source: 'user_upload',
        media_type: 'image',
        mime_type: String(mime_type),
        path: storedMediaPath,
        caption: caption || undefined,
        alt: String(filename),
      };
      storeMediaArtifact(artifact);

      const content = this.buildMediaMessageContent(artifact, {
        fileLabel: String(filename),
        agentPath,
      });

      const msg: NewMessage = {
        id: randomUUID(),
        chat_jid: jid,
        sender: 'web-user',
        sender_name: 'Web User',
        content,
        timestamp: new Date().toISOString(),
        is_from_me: false,
        is_bot_message: false,
        thread_id: thread_id || undefined,
      };

      if (thread_id) {
        // Thread reply: store in the origin chat, mirror to the thread agent,
        // and enqueue that agent just like a text thread reply.
        this.opts.onMessage(jid, msg);
        const threadInfo = this.opts.getThreadInfo?.(thread_id);
        if (threadInfo) {
          storeMessageDirect({
            id: `${msg.id}_thread_${threadInfo.agentJid}`,
            chat_jid: threadInfo.agentJid,
            sender: msg.sender,
            sender_name: msg.sender_name,
            content: msg.content,
            timestamp: msg.timestamp,
            is_from_me: false,
            is_bot_message: msg.is_bot_message,
            thread_id,
          });
          this.opts.onThreadReply?.(thread_id, threadInfo.agentJid);
        }
      } else {
        this.opts.onMessage(jid, msg);
      }
      this.broadcast('user_message', { jid, message: msg });
      return this.json(res, 201, { ok: true, artifactId });
    }

    // POST /api/groups/:folder/agents — add or clone an agent into a group
    const addAgentMatch = url.pathname.match(
      /^\/api\/groups\/([A-Za-z0-9_-]+)\/agents$/,
    );
    if (method === 'POST' && addAgentMatch) {
      const folder = `web_${decodeURIComponent(addAgentMatch[1])}`;
      const jid = `web:${decodeURIComponent(addAgentMatch[1])}`;
      const group = this.opts.registeredGroups()[jid];
      if (!group || group.folder !== folder) {
        return this.json(res, 404, { error: 'Group not found' });
      }

      const body = await this.readBody(req);
      const {
        name,
        displayName,
        trigger,
        instructions,
        sourceGroupJid,
        sourceAgentName,
        runtime,
      } = body as {
        name?: string;
        displayName?: string;
        trigger?: string;
        instructions?: string;
        sourceGroupJid?: string;
        sourceAgentName?: string;
        runtime?: {
          provider?: string;
          model?: string;
          baseUrl?: string;
          temperature?: number;
          maxTokens?: number;
        };
      };

      if (!name?.trim()) {
        return this.json(res, 400, { error: 'Agent name is required' });
      }

      const agentName = this.sanitizeAgentName(name.trim());
      if (!agentName) {
        return this.json(res, 400, { error: 'Agent name is invalid' });
      }
      if (
        (sourceGroupJid && !sourceAgentName) ||
        (!sourceGroupJid && sourceAgentName)
      ) {
        return this.json(res, 400, {
          error: 'Source group and source agent are both required for cloning',
        });
      }

      const groupDir = this.getGroupDir(group.folder);
      const agentDir = path.join(groupDir, 'agents', agentName);
      if (fs.existsSync(agentDir)) {
        return this.json(res, 409, { error: 'Agent already exists' });
      }

      let claudeMd = instructions?.trim();
      let agentConfig: Record<string, unknown> = {};

      if (sourceGroupJid && sourceAgentName) {
        const sourceGroup = this.opts.registeredGroups()[sourceGroupJid];
        if (!sourceGroup) {
          return this.json(res, 404, { error: 'Source group not found' });
        }

        const sourceAgent = discoverAgents(sourceGroup).find(
          (agent) => agent.name === sourceAgentName,
        );
        if (!sourceAgent) {
          return this.json(res, 404, { error: 'Source agent not found' });
        }

        const sourceClaudeMd = resolveAgentClaudeMdPath(sourceAgent);
        if (fs.existsSync(sourceClaudeMd)) {
          claudeMd = fs.readFileSync(sourceClaudeMd, 'utf-8');
        }

        const sourceAgentDir = path.join(
          this.getGroupDir(sourceGroup.folder),
          'agents',
          sourceAgent.name,
        );
        const sourceAgentJson = path.join(sourceAgentDir, 'agent.json');
        agentConfig = this.readJsonFile(sourceAgentJson);
      }

      fs.mkdirSync(agentDir, { recursive: true });

      fs.writeFileSync(
        path.join(agentDir, 'CLAUDE.md'),
        (claudeMd && claudeMd.length > 0
          ? claudeMd
          : `# ${displayName?.trim() || name.trim()}\n\nYou are a specialist in the ${group.name} group.\n`) +
          (claudeMd?.endsWith('\n') ? '' : '\n'),
      );

      agentConfig = {
        ...agentConfig,
        displayName:
          displayName?.trim() || agentConfig.displayName || name.trim(),
      };
      if (trigger?.trim()) {
        agentConfig.trigger = trigger.trim();
      } else if (!sourceAgentName && 'trigger' in agentConfig) {
        delete agentConfig.trigger;
      }
      if (runtime?.provider) {
        agentConfig.runtime = {
          provider: runtime.provider,
          ...(runtime.model ? { model: runtime.model } : {}),
          ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
          ...(runtime.temperature !== undefined
            ? { temperature: runtime.temperature }
            : {}),
          ...(runtime.maxTokens !== undefined
            ? { maxTokens: runtime.maxTokens }
            : {}),
        };
      }

      fs.writeFileSync(
        path.join(agentDir, 'agent.json'),
        JSON.stringify(agentConfig, null, 2) + '\n',
      );

      return this.refreshAgentsAndRespond(res, jid);
    }

    // PATCH /api/groups/:folder/agents/:agent — update agent metadata
    const patchAgentMatch = url.pathname.match(
      /^\/api\/groups\/([A-Za-z0-9_-]+)\/agents\/([A-Za-z0-9_-]+)$/,
    );
    if (method === 'PATCH' && patchAgentMatch) {
      const folderSlug = decodeURIComponent(patchAgentMatch[1]);
      const agentName = decodeURIComponent(patchAgentMatch[2]);
      const jid = `web:${folderSlug}`;
      const group = this.opts.registeredGroups()[jid];
      if (!group) {
        return this.json(res, 404, { error: 'Group not found' });
      }

      const agentDir = path.join(
        this.getGroupDir(group.folder),
        'agents',
        agentName,
      );
      const body = await this.readBody(req);
      const { displayName, trigger, runtime, tools, skills } = body as {
        displayName?: string;
        trigger?: string;
        runtime?: {
          provider?: string;
          model?: string;
          baseUrl?: string;
          temperature?: number;
          maxTokens?: number;
        } | null;
        tools?: string[] | null;
        skills?: string[] | null;
      };

      if (!fs.existsSync(agentDir)) {
        if (agentName === DEFAULT_AGENT_NAME) {
          return this.json(res, 400, {
            error:
              'Implicit default agent metadata is inherited from the group',
          });
        }
        return this.json(res, 404, { error: 'Agent folder not found' });
      }

      const configPath = path.join(agentDir, 'agent.json');
      const config = this.readJsonFile(configPath);

      if (displayName !== undefined) {
        const trimmed = displayName.trim();
        config.displayName = trimmed || agentName;
      }

      if (trigger !== undefined) {
        const trimmed = trigger.trim();
        if (trimmed) {
          config.trigger = trimmed;
        } else {
          delete config.trigger;
        }
      }

      if (tools !== undefined) {
        if (tools === null) {
          delete config.tools;
        } else if (Array.isArray(tools)) {
          // Reject explicit tool lists for runtimes that can't consume
          // them — the Ollama text-only path ignores `allowedTools`, so
          // saving would silently dead-letter. Callers can still clear
          // (tools: null) to reset any stale value.
          const effectiveRuntime = (config.runtime || undefined) as
            | AgentRuntimeConfig
            | undefined;
          if (!getCapabilityProfile(effectiveRuntime).receivesMcpTools) {
            return this.json(res, 400, {
              error:
                "This agent's runtime does not support tool calling — tool selection has no effect. Clear the field (tools: null) or switch to a tool-capable model.",
            });
          }
          const cleanTools = tools.filter(
            (t: unknown): t is string => typeof t === 'string' && t.length > 0,
          );
          // Verify every requested tool is supported by the agent's runtime.
          // Single source of truth: the capability profile (via
          // listToolsForRuntime) decides what's invokable. Silent acceptance
          // of unsupported tools would persist a tool the adapter can't plumb,
          // so the saved agent.json would drift from runtime behavior.
          const supportedNames = new Set(
            listToolsForRuntime(effectiveRuntime).map((t) => t.name),
          );
          const unsupported = cleanTools.filter((t) => !supportedNames.has(t));
          if (unsupported.length > 0) {
            const provider = effectiveRuntime?.provider || 'anthropic';
            return this.json(res, 400, {
              error: `Tools (${unsupported.join(', ')}) are not available on the ${provider} runtime. Remove them or switch this agent's runtime.`,
            });
          }
          config.tools = cleanTools;
        } else {
          return this.json(res, 400, {
            error: 'tools must be an array of strings or null',
          });
        }
      }

      if (skills !== undefined) {
        if (skills === null) {
          delete config.skills;
        } else if (Array.isArray(skills)) {
          const cleanSkills = skills.filter(
            (s: unknown): s is string => typeof s === 'string' && s.length > 0,
          );
          // Validate against the live skill directory so we don't persist a
          // typo that would silently filter to zero skills at container spawn.
          const skillsDir = path.join(process.cwd(), 'container', 'skills');
          const known = new Set<string>(
            fs.existsSync(skillsDir)
              ? fs
                  .readdirSync(skillsDir)
                  .filter((d) =>
                    fs.statSync(path.join(skillsDir, d)).isDirectory(),
                  )
              : [],
          );
          const unknown = cleanSkills.filter((s) => !known.has(s));
          if (unknown.length > 0) {
            return this.json(res, 400, {
              error: `Skills (${unknown.join(', ')}) are not available. Known: ${[...known].join(', ') || '(none)'}.`,
            });
          }
          config.skills = cleanSkills;
        } else {
          return this.json(res, 400, {
            error: 'skills must be an array of strings or null',
          });
        }
      }

      if (runtime !== undefined) {
        if (runtime === null) {
          delete config.runtime;
        } else {
          const VALID_PROVIDERS = [
            'anthropic',
            'ollama',
            'openai',
            'github-copilot',
            'azure-openai',
            'openrouter',
            'litellm',
          ];
          if (runtime.provider && !VALID_PROVIDERS.includes(runtime.provider)) {
            return this.json(res, 400, {
              error: `Invalid provider "${runtime.provider}". Valid: ${VALID_PROVIDERS.join(', ')}`,
            });
          }
          if (runtime.provider === 'ollama' && !runtime.model) {
            return this.json(res, 400, {
              error: 'Ollama provider requires a model (e.g. "llama3.2")',
            });
          }
          config.runtime = {
            ...(runtime.provider ? { provider: runtime.provider } : {}),
            ...(runtime.model ? { model: runtime.model } : {}),
            ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
            ...(runtime.temperature !== undefined
              ? { temperature: runtime.temperature }
              : {}),
            ...(runtime.maxTokens !== undefined
              ? { maxTokens: runtime.maxTokens }
              : {}),
          };
        }
      }

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

      // Evict warm pool container when runtime config changes —
      // the pooled container has the old provider/model baked in.
      // Await to ensure the old container is stopped before responding,
      // so the next message uses the new runtime.
      if (runtime !== undefined) {
        await this.opts.onAgentRuntimeChanged?.(group.folder, agentName);
      }

      return this.refreshAgentsAndRespond(res, jid);
    }

    // GET /api/groups/:folder/agents/:agent/runtime-profile — inspect
    // declared/effective runtime and resolved capabilities for an agent.
    const runtimeProfileMatch = url.pathname.match(
      /^\/api\/groups\/([A-Za-z0-9_-]+)\/agents\/([A-Za-z0-9_-]+)\/runtime-profile$/,
    );
    if (method === 'GET' && runtimeProfileMatch) {
      const folderSlug = decodeURIComponent(runtimeProfileMatch[1]);
      const agentName = decodeURIComponent(runtimeProfileMatch[2]);
      const jid = `web:${folderSlug}`;
      const group = this.opts.registeredGroups()[jid];
      if (!group) {
        return this.json(res, 404, { error: 'Group not found' });
      }

      const agents =
        this.opts.getDiscoveredAgents?.(jid) || discoverAgents(group);
      const agent = agents.find((entry) => entry.name === agentName);
      if (!agent) {
        return this.json(res, 404, { error: 'Agent not found' });
      }

      const declaredRuntime = agent.runtime || null;
      const effectiveRuntime = resolveEffectiveRuntime(agent, group.folder);
      const profile = resolveRuntimeProfile(effectiveRuntime);
      const currentProfile = resolveRuntimeProfile(agent.runtime);
      const compatibility = compareRuntimeProfiles(currentProfile, profile);

      return this.json(res, 200, {
        agent: {
          id: agent.id,
          name: agent.name,
          displayName: agent.displayName,
        },
        declaredRuntime,
        effectiveRuntime,
        resolvedProfile: profile,
        compatibilityFromDeclared: compatibility,
      });
    }

    // DELETE /api/groups/:folder/agents/:agent — remove an agent from a group
    const deleteAgentMatch = url.pathname.match(
      /^\/api\/groups\/([A-Za-z0-9_-]+)\/agents\/([A-Za-z0-9_-]+)$/,
    );
    if (method === 'DELETE' && deleteAgentMatch) {
      const folderSlug = decodeURIComponent(deleteAgentMatch[1]);
      const agentName = decodeURIComponent(deleteAgentMatch[2]);
      const jid = `web:${folderSlug}`;
      const group = this.opts.registeredGroups()[jid];
      if (!group) {
        return this.json(res, 404, { error: 'Group not found' });
      }

      const agents = this.opts.getGroupAgents?.(jid) || [];
      if (agents.length <= 1) {
        return this.json(res, 400, {
          error: 'Groups must keep at least one agent',
        });
      }
      if (!agents.some((agent) => agent.name === agentName)) {
        return this.json(res, 404, { error: 'Agent not found' });
      }

      const agentDir = path.join(
        this.getGroupDir(group.folder),
        'agents',
        agentName,
      );
      if (!fs.existsSync(agentDir)) {
        if (agentName === DEFAULT_AGENT_NAME) {
          return this.json(res, 400, {
            error: 'Cannot remove an implicit default agent',
          });
        }
        return this.json(res, 404, { error: 'Agent folder not found' });
      }

      fs.rmSync(agentDir, { recursive: true, force: true });
      return this.refreshAgentsAndRespond(res, jid);
    }

    // GET /api/tools[?provider=&model=] — list tools available for per-agent
    // allowlists (#74 Phase 2b). Static catalogue: Claude SDK built-ins +
    // nanoclaw MCP tools. Kept in sync with
    // container/agent-runner/src/claude-runtime.ts and
    // container/agent-runner/src/ipc-mcp-stdio.ts.
    // When provider/model are supplied, the list is filtered to only the
    // tools that runtime can actually invoke (#124 — capability profile is
    // the source of truth, no separate UI heuristic).
    if (method === 'GET' && url.pathname === '/api/tools') {
      const providerParam = url.searchParams.get('provider');
      const model = url.searchParams.get('model');
      const VALID_PROVIDERS: RuntimeProvider[] = [
        'anthropic',
        'ollama',
        'openai',
        'github-copilot',
        'azure-openai',
        'openrouter',
        'litellm',
      ];
      if (
        providerParam &&
        (VALID_PROVIDERS as string[]).includes(providerParam)
      ) {
        const runtime: AgentRuntimeConfig = {
          provider: providerParam as RuntimeProvider,
        };
        if (model) runtime.model = model;
        return this.json(res, 200, {
          tools: listToolsForRuntime(runtime),
          runtime,
        });
      }
      return this.json(res, 200, { tools: listAvailableTools() });
    }

    // GET /api/skills — list available container-level skills for per-agent
    // allowlists (#74 Phase 3 UI completion). Reads container/skills/* and
    // pulls name + description from each SKILL.md's frontmatter so the UI
    // can render a meaningful checklist.
    if (method === 'GET' && url.pathname === '/api/skills') {
      const skillsDir = path.join(process.cwd(), 'container', 'skills');
      const skills: Array<{ name: string; description: string }> = [];
      if (fs.existsSync(skillsDir)) {
        for (const dir of fs.readdirSync(skillsDir)) {
          const skillPath = path.join(skillsDir, dir);
          if (!fs.statSync(skillPath).isDirectory()) continue;
          const md = path.join(skillPath, 'SKILL.md');
          if (!fs.existsSync(md)) continue;
          // Frontmatter is YAML-ish; pull the two fields the UI needs
          // without taking a yaml dep. SKILL.md frontmatter is validated
          // by scripts/validate-skills.mjs so the format is stable.
          const head = fs.readFileSync(md, 'utf-8').slice(0, 2000);
          const fm = head.match(/^---\n([\s\S]*?)\n---/);
          let nameVal = dir;
          let descVal = '';
          if (fm) {
            const nameMatch = fm[1].match(/^name:\s*(.+)$/m);
            const descMatch = fm[1].match(/^description:\s*(.+)$/m);
            if (nameMatch) nameVal = nameMatch[1].trim();
            if (descMatch) descVal = descMatch[1].trim();
          }
          skills.push({ name: nameVal, description: descVal });
        }
      }
      skills.sort((a, b) => a.name.localeCompare(b.name));
      return this.json(res, 200, { skills });
    }

    // GET /api/ollama/models — list locally available Ollama models
    if (method === 'GET' && url.pathname === '/api/ollama/models') {
      const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
      try {
        const response = await fetch(`${ollamaHost}/api/tags`);
        if (!response.ok) {
          return this.json(res, 200, {
            models: [],
            error: `Ollama returned ${response.status}`,
          });
        }
        const data = (await response.json()) as {
          models?: Array<{
            name: string;
            size: number;
            modified_at: string;
          }>;
        };
        return this.json(res, 200, {
          models: (data.models || []).map((m) => ({
            name: m.name,
            size: m.size,
            modified: m.modified_at,
          })),
        });
      } catch {
        return this.json(res, 200, {
          models: [],
          error: `Ollama is not reachable at ${ollamaHost}`,
        });
      }
    }

    // GET /api/models — list models advertised by the Anthropic-compatible
    // upstream (LiteLLM gateway, the official API, etc.). 5 min cache.
    if (method === 'GET' && url.pathname === '/api/models') {
      const cached = readUpstreamModelsCache();
      if (cached) return this.json(res, 200, cached);

      const creds = resolveAnthropicCredentials();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      // Anthropic-style upstreams require anthropic-version for both auth
      // modes; LiteLLM-style upstreams ignore it harmlessly.
      headers['anthropic-version'] = '2023-06-01';
      if (creds.authMode === 'api-key' && creds.apiKey) {
        headers['x-api-key'] = creds.apiKey;
      } else if (creds.oauthToken) {
        headers['Authorization'] = `Bearer ${creds.oauthToken}`;
      } else {
        const payload = {
          models: [],
          error: 'No Anthropic credentials configured',
        };
        writeUpstreamModelsCache(payload);
        return this.json(res, 200, payload);
      }

      try {
        const response = await fetch(`${creds.baseUrl}/v1/models`, {
          headers,
        });
        if (!response.ok) {
          const payload = {
            models: [],
            error: `Upstream returned ${response.status}`,
            baseUrl: creds.baseUrl,
          };
          writeUpstreamModelsCache(payload);
          return this.json(res, 200, payload);
        }
        const data = (await response.json()) as {
          data?: Array<{ id?: string; owned_by?: string }>;
          models?: Array<{ id?: string }>;
        };
        // OpenAI-compatible: { data: [{ id, owned_by, ... }] }. Some upstreams
        // wrap as { models: [{ id }] }; tolerate both.
        const raw = (Array.isArray(data.data) ? data.data : data.models) || [];
        const models = raw
          .map((m) => ({
            id: typeof m.id === 'string' ? m.id : '',
            owner:
              typeof (m as { owned_by?: string }).owned_by === 'string'
                ? (m as { owned_by?: string }).owned_by
                : undefined,
          }))
          .filter((m) => m.id.length > 0);
        const payload = { models, baseUrl: creds.baseUrl };
        writeUpstreamModelsCache(payload);
        return this.json(res, 200, payload);
      } catch (err) {
        const payload = {
          models: [],
          error: `Upstream not reachable: ${err instanceof Error ? err.message : String(err)}`,
          baseUrl: creds.baseUrl,
        };
        // Don't cache transient network failures — short-circuit to ~30s
        // so a fix shows up quickly.
        writeUpstreamModelsCache(payload, 30_000);
        return this.json(res, 200, payload);
      }
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
      this.broadcastGroupsChanged();
      return this.json(res, 201, { jid, group });
    }

    // POST /api/teams — create a multi-agent team (coordinator + specialists)
    if (method === 'POST' && url.pathname === '/api/teams') {
      const body = await this.readBody(req);
      const { name, folder, coordinator, specialists } = body as unknown as {
        name: string;
        folder: string;
        coordinator: {
          name?: string;
          displayName?: string;
          instructions?: string;
          runtime?: { provider?: string; model?: string };
        };
        specialists: Array<{
          name: string;
          displayName?: string;
          trigger: string;
          instructions?: string;
          runtime?: { provider?: string; model?: string };
        }>;
      };
      if (
        !name ||
        !folder ||
        !coordinator ||
        !Array.isArray(specialists) ||
        specialists.length === 0
      ) {
        return this.json(res, 400, {
          error:
            'name, folder, coordinator, and at least one specialist required',
        });
      }
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

      // Validate specialist names are unique and valid
      const names = new Set<string>();
      const coordName = coordinator.name || 'coordinator';
      names.add(coordName);
      for (const spec of specialists) {
        if (!spec.name || !spec.trigger) {
          return this.json(res, 400, {
            error: 'Each specialist needs a name and trigger',
          });
        }
        const specName = spec.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        if (names.has(specName)) {
          return this.json(res, 400, {
            error: `Duplicate agent name: ${specName}`,
          });
        }
        names.add(specName);
      }

      const groupFolder = `web_${folder}`;
      const groupDir = path.resolve(process.cwd(), 'groups', groupFolder);

      // Build a "first specialist" hint for the coordinator's example.
      // Falls back to a placeholder if (somehow) no specialists.
      const exampleSpec = specialists[0];
      const exampleAgent = exampleSpec
        ? exampleSpec.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
        : 'specialist';

      // Default CLAUDE.md content branches on whether the agent's runtime
      // actually receives MCP tools today. Ollama (and any non-Claude
      // runtime) gets a text-only variant — telling a tool-less agent to
      // "call the tool" produces narration-of-tool-calls, not real work.
      const defaultCoordinatorMd = (
        displayName: string,
        receivesMcpTools: boolean,
      ) => {
        if (!receivesMcpTools) {
          return `# ${displayName}

You are the coordinator for the ${name} team.

Your runtime does not have tool-calling access, so you cannot delegate work programmatically. Answer user requests directly from your own knowledge.

If a question is clearly within another agent's specialty, say so and point the user at the specialist's trigger (e.g. \`@${exampleAgent}\`) — they can re-route the request themselves.

Your plain-text reply is delivered as the user-visible message.
`;
        }
        return `# ${displayName}

You are the coordinator for the ${name} team.

## How to delegate

When a request fits a specialist, **call the tool** — do not narrate what you would do:

\`\`\`
mcp__nanoclaw__delegate_to_agent({
  agent: "${exampleAgent}",
  message: "Specific instructions for the specialist"
})
\`\`\`

Saying "I'll send this to ${exampleAgent}" without invoking the tool is a bug — the specialist will never run.

## When to respond directly

For general questions that don't fit a specialist, answer yourself.

## Synthesis

When all delegated specialists finish, synthesize their outputs into one response. Don't relay raw specialist output unless it's already final-quality.
`;
      };

      const defaultSpecialistMd = (
        displayName: string,
        trigger: string,
        receivesMcpTools: boolean,
      ) => {
        if (!receivesMcpTools) {
          return `# ${displayName}

You are a specialist on the ${name} team. Your trigger is \`${trigger}\`.

## Your role

When the coordinator delegates work to you, respond in plain text. Your entire reply is delivered to the user as your message, so keep it self-contained.

## Boundaries

You do not have tools, sidebar controls, or the ability to delegate. If a request falls outside your role, say so plainly — the coordinator will route it.
`;
        }
        return `# ${displayName}

You are a specialist on the ${name} team. Your trigger is \`${trigger}\`.

## Your role

Focus on the work the coordinator delegates to you. Respond directly with the answer or artifact — the coordinator will handle synthesis and follow-up.

## Boundaries

You do not delegate. If something falls outside your role, say so plainly in your response and the coordinator will route it.
`;
      };

      // Group-level CLAUDE.md
      fs.mkdirSync(groupDir, { recursive: true });
      fs.writeFileSync(
        path.join(groupDir, 'CLAUDE.md'),
        `# ${name}\n\nMulti-agent team. See agents/ for individual agent instructions.\n`,
      );

      // Coordinator agent
      const coordDir = path.join(groupDir, 'agents', coordName);
      fs.mkdirSync(coordDir, { recursive: true });
      const coordDisplayName = coordinator.displayName || 'Coordinator';
      const coordProfile = getCapabilityProfile(
        coordinator.runtime as AgentRuntimeConfig | undefined,
      );
      fs.writeFileSync(
        path.join(coordDir, 'CLAUDE.md'),
        coordinator.instructions ||
          defaultCoordinatorMd(coordDisplayName, coordProfile.receivesMcpTools),
      );
      const coordAgentJson: Record<string, unknown> = {
        displayName: coordDisplayName,
      };
      if (coordinator.runtime && coordinator.runtime.provider) {
        coordAgentJson.runtime = coordinator.runtime;
      }
      fs.writeFileSync(
        path.join(coordDir, 'agent.json'),
        JSON.stringify(coordAgentJson, null, 2) + '\n',
      );

      // Specialist agents
      for (const spec of specialists) {
        const specName = spec.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        const specDir = path.join(groupDir, 'agents', specName);
        fs.mkdirSync(specDir, { recursive: true });
        const specDisplayName = spec.displayName || spec.name;
        const specProfile = getCapabilityProfile(
          spec.runtime as AgentRuntimeConfig | undefined,
        );
        fs.writeFileSync(
          path.join(specDir, 'CLAUDE.md'),
          spec.instructions ||
            defaultSpecialistMd(
              specDisplayName,
              spec.trigger,
              specProfile.receivesMcpTools,
            ),
        );
        const specAgentJson: Record<string, unknown> = {
          displayName: specDisplayName,
          trigger: spec.trigger,
        };
        if (spec.runtime && spec.runtime.provider) {
          specAgentJson.runtime = spec.runtime;
        }
        fs.writeFileSync(
          path.join(specDir, 'agent.json'),
          JSON.stringify(specAgentJson, null, 2) + '\n',
        );
      }

      // Register the group
      const group: RegisteredGroup = {
        name,
        folder: groupFolder,
        trigger: `@${name}`,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
      };

      this.opts.onRegisterGroup?.(jid, group);
      this.opts.onChatMetadata(
        jid,
        new Date().toISOString(),
        name,
        'web',
        true,
      );
      this.broadcastGroupsChanged();
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
      this.broadcastGroupsChanged();
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

    // GET /api/portal-threads/:jid — portal (side-drawer) threads for a chat
    const portalThreadsMatch = url.pathname.match(
      /^\/api\/portal-threads\/(.+)$/,
    );
    if (method === 'GET' && portalThreadsMatch) {
      const jid = decodeURIComponent(portalThreadsMatch[1]);
      const threads = getPortalThreadsForChat(jid);
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
      // #141 — attach block-state overlay so the renderer can merge per-block
      // state without a follow-up fetch. Empty when no agent has called
      // update_block on any message in this page.
      const blockState = getBlockStateForMessages(messages.map((m) => m.id));
      const withState = messages.map((m) => ({
        ...m,
        block_state: blockState[m.id] || undefined,
      }));
      return this.json(res, 200, { messages: withState });
    }

    // #147 — DELETE /api/messages/:jid/:message_id — delete a single message
    // and cascade adjacent state (block_state, pin threads). Must match
    // BEFORE the clear-all route below — the greedy regex on the existing
    // route would otherwise swallow the two-segment path.
    const singleDeleteMatch = url.pathname.match(
      /^\/api\/messages\/([^/]+)\/([^/]+)$/,
    );
    if (method === 'DELETE' && singleDeleteMatch) {
      const jid = decodeURIComponent(singleDeleteMatch[1]);
      const messageId = decodeURIComponent(singleDeleteMatch[2]);
      if (!jid.startsWith('web:')) {
        return this.json(res, 400, { error: 'jid must start with web:' });
      }
      const summary = deleteMessage(jid, messageId);
      if (!summary.messageExisted) {
        return this.json(res, 404, {
          error: 'message not found in this chat',
        });
      }
      // Broadcast the message_deleted event so all connected clients can
      // remove the row from their local state. One pin_removed event per
      // cascaded pin so existing pin-handling logic doesn't need to know
      // about the new delete path.
      this.broadcast('message_deleted', {
        jid,
        message_id: messageId,
        cascaded: {
          block_state: summary.blockStateRows,
          pins: summary.pinThreadIds.length,
        },
      });
      for (const threadId of summary.pinThreadIds) {
        this.broadcastPinRemoved({ jid, thread_id: threadId });
      }
      logger.info(
        {
          jid,
          messageId,
          blockStateRows: summary.blockStateRows,
          pinThreadIds: summary.pinThreadIds.length,
        },
        'Message deleted',
      );
      return this.json(res, 200, {
        ok: true,
        cascaded: {
          block_state: summary.blockStateRows,
          pins: summary.pinThreadIds.length,
        },
      });
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
      const { jid, content, sender, thread_id, reply_to_message_id } = body;
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

      // #140 — validate quote-reply anchor: must reference a real message in
      // the same chat. Reject silently-bad IDs so the UI can correct itself.
      if (reply_to_message_id) {
        if (typeof reply_to_message_id !== 'string') {
          return this.json(res, 400, {
            error: 'reply_to_message_id must be a string',
          });
        }
        const referenced = getMessageById(reply_to_message_id, jid);
        if (!referenced) {
          return this.json(res, 400, {
            error:
              'reply_to_message_id does not reference a message in this chat',
          });
        }
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
        reply_to_message_id: reply_to_message_id || null,
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

    // POST /api/action — invoke an action-button with target:"thread".
    // Mints a portal thread routed to a specific specialist agent, then
    // reuses the shared delegation machinery via onUserDelegation.
    if (method === 'POST' && url.pathname === '/api/action') {
      const body = await this.readBody(req);
      const { jid, target_agent, label, action_message, sender } = body;
      if (!jid || !target_agent || !action_message) {
        return this.json(res, 400, {
          error: 'jid, target_agent, and action_message are required',
        });
      }
      if (!jid.startsWith('web:')) {
        return this.json(res, 400, { error: 'jid must start with web:' });
      }
      const groups = this.opts.registeredGroups();
      const group = groups[jid];
      if (!group) {
        return this.json(res, 404, { error: 'Group not registered' });
      }
      if (!this.opts.onUserDelegation) {
        return this.json(res, 503, {
          error: 'Delegation handler not wired on this channel',
        });
      }
      this.opts.onUserDelegation({
        sourceGroup: group.folder,
        chatJid: jid,
        targetAgent: target_agent,
        message: action_message,
        // The prompt string "Delegation from X" is surfaced to the
        // specialist; user-initiated actions read more naturally as
        // "the user" than as a synthetic identifier.
        sourceAgent: sender || 'the user',
        // Button label becomes the portal's title so concurrent actions
        // to the same specialist are distinguishable in pills/sections.
        title: label || undefined,
      });
      logger.info(
        { jid, target_agent, label },
        'Portal action invoked from web UI',
      );
      return this.json(res, 200, { ok: true });
    }

    // #142 — Pin endpoints. Pins are persistent references to a message
    // (and optionally a specific block within it) that render in the
    // side drawer. Created from the UI (POST), listed on group switch
    // (GET ?jid=...), and dismissed by the user (DELETE /:thread_id).
    //
    // GET /api/pins?jid=... — list all pins for a chat
    if (method === 'GET' && url.pathname === '/api/pins') {
      const jid = url.searchParams.get('jid');
      if (!jid) {
        return this.json(res, 400, { error: 'jid query param is required' });
      }
      const pins = getPinsForChat(jid);
      return this.json(res, 200, { pins });
    }

    // POST /api/pins — create a pin
    if (method === 'POST' && url.pathname === '/api/pins') {
      const body = await this.readBody(req);
      const { jid, message_id, block_id, title } = body;
      if (!jid || !message_id) {
        return this.json(res, 400, {
          error: 'jid and message_id are required',
        });
      }
      if (!jid.startsWith('web:')) {
        return this.json(res, 400, { error: 'jid must start with web:' });
      }
      // Validate the message exists in this chat (mirrors quote-reply check)
      const msg = getMessageById(message_id, jid);
      if (!msg) {
        return this.json(res, 404, {
          error: 'message_id does not reference a message in this chat',
        });
      }
      const threadId = `pin-${randomUUID()}`;
      const cleanBlockId =
        typeof block_id === 'string' && block_id ? block_id : null;
      const cleanTitle =
        typeof title === 'string' && title.trim()
          ? title.trim().slice(0, 200)
          : null;
      createPinThread(threadId, jid, message_id, cleanBlockId, cleanTitle);
      const created_at = new Date().toISOString();
      this.broadcastPinCreated({
        jid,
        thread_id: threadId,
        message_id,
        block_id: cleanBlockId,
        title: cleanTitle,
        created_at,
      });
      logger.info(
        { jid, thread_id: threadId, message_id, block_id: cleanBlockId },
        'Pin created',
      );
      return this.json(res, 200, {
        ok: true,
        thread_id: threadId,
        created_at,
      });
    }

    // DELETE /api/pins/:thread_id — remove a pin
    const pinDeleteMatch = url.pathname.match(/^\/api\/pins\/(.+)$/);
    if (method === 'DELETE' && pinDeleteMatch) {
      const threadId = decodeURIComponent(pinDeleteMatch[1]);
      // Look up the pin BEFORE deleting so we know which jid to scope
      // the broadcast to. Clients filter their local state by jid.
      const pin = getPinByThreadId(threadId);
      const removed = deletePinThread(threadId);
      if (!removed) {
        return this.json(res, 404, { error: 'pin not found' });
      }
      this.broadcastPinRemoved({
        jid: pin?.origin_jid || '',
        thread_id: threadId,
      });
      logger.info({ thread_id: threadId }, 'Pin removed');
      return this.json(res, 200, { ok: true });
    }

    // #143 — POST /api/abort — interrupt an in-flight agent run for a chat.
    // mode: 'stop' graceful (close stdin, agent finishes current tool call);
    // mode: 'kill' hard-stop (docker stop on coordinator + delegations).
    if (method === 'POST' && url.pathname === '/api/abort') {
      const body = await this.readBody(req);
      const { jid, mode } = body;
      if (!jid || typeof jid !== 'string') {
        return this.json(res, 400, { error: 'jid is required' });
      }
      const requestedMode = mode === 'kill' ? 'kill' : 'stop';
      if (!this.opts.onAbortRun) {
        return this.json(res, 503, {
          error: 'Abort handler not wired on this channel',
        });
      }
      const result = await this.opts.onAbortRun({ jid, mode: requestedMode });
      if (!result.found) {
        return this.json(res, 404, { error: 'no run in flight for this jid' });
      }
      logger.info(
        {
          jid,
          mode: result.mode,
          coordinator: result.coordinatorContainer,
          delegations: result.delegationContainers?.length || 0,
        },
        'Run aborted',
      );
      return this.json(res, 200, { ok: true, ...result });
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
      this.broadcastGroupsChanged();
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
      this.broadcastGroupsChanged();
      return this.json(res, 200, { ok: true });
    }

    // POST /api/tasks/:id/run — manually trigger a task immediately
    const taskRunMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/run$/);
    if (method === 'POST' && taskRunMatch) {
      const taskId = decodeURIComponent(taskRunMatch[1]);
      const task = getTaskById(taskId);
      if (!task) return this.json(res, 404, { error: 'Task not found' });
      if (!this.opts.onRunTaskNow) {
        return this.json(res, 503, {
          error: 'Manual task trigger not wired on this channel',
        });
      }
      try {
        this.opts.onRunTaskNow(taskId);
      } catch (err) {
        return this.json(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return this.json(res, 202, { ok: true });
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
      this.broadcastGroupsChanged();
      return this.json(res, 200, { ok: true });
    }

    // PATCH /api/tasks/:id — update task metadata
    const taskPatchMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (method === 'PATCH' && taskPatchMatch) {
      const taskId = decodeURIComponent(taskPatchMatch[1]);
      const task = getTaskById(taskId);
      if (!task) return this.json(res, 404, { error: 'Task not found' });

      const body = await this.readBody(req);
      const updates: Parameters<typeof updateTask>[1] = {};

      if (body.title !== undefined) updates.title = body.title;
      if (body.prompt !== undefined) updates.prompt = body.prompt;
      if (body.script !== undefined) updates.script = body.script || null;
      if (body.schedule_type !== undefined) {
        if (!['cron', 'interval', 'once'].includes(body.schedule_type)) {
          return this.json(res, 400, {
            error: 'schedule_type must be cron, interval, or once',
          });
        }
        updates.schedule_type =
          body.schedule_type as ScheduledTask['schedule_type'];
      }
      if (body.schedule_value !== undefined) {
        updates.schedule_value = body.schedule_value;
      }

      if (Object.keys(updates).length === 0) {
        return this.json(res, 400, { error: 'no updatable fields provided' });
      }

      if (updates.schedule_type || updates.schedule_value) {
        const merged = { ...task, ...updates } as ScheduledTask;
        try {
          updates.next_run = computeNextRun(merged);
        } catch {
          return this.json(res, 400, {
            error: 'invalid schedule_value for schedule_type',
          });
        }
      }

      updateTask(taskId, updates);
      this.broadcastGroupsChanged();
      return this.json(res, 200, { task: getTaskById(taskId) });
    }

    // DELETE /api/tasks/:id — cancel/delete a task
    const taskDeleteMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (method === 'DELETE' && taskDeleteMatch) {
      const taskId = decodeURIComponent(taskDeleteMatch[1]);
      const task = getTaskById(taskId);
      if (!task) return this.json(res, 404, { error: 'Task not found' });
      deleteTask(taskId);
      this.broadcastGroupsChanged();
      return this.json(res, 200, { ok: true });
    }

    // GET /api/transcript?group=folder[&run_id=N] — parse the session transcript
    // for a group, optionally scoped to a single agent_runs row's time window.
    if (method === 'GET' && url.pathname === '/api/transcript') {
      const folder = url.searchParams.get('group');
      if (!folder) return this.json(res, 400, { error: 'group required' });

      const runIdParam = url.searchParams.get('run_id');
      let runWindow: { start: number; end: number } | null = null;
      let runSessionId: string | null = null;
      let runMeta: {
        id: number;
        timestamp: string;
        duration_ms: number;
        cost_usd: number;
        num_turns: number;
        session_id?: string;
      } | null = null;
      if (runIdParam) {
        const runId = parseInt(runIdParam, 10);
        if (!Number.isFinite(runId)) {
          return this.json(res, 400, { error: 'invalid run_id' });
        }
        const run = getAgentRunById(runId);
        if (!run) {
          return this.json(res, 404, { error: 'run not found' });
        }
        // Reject cross-group requests: the URL's ?group= must match the
        // run's recorded group_folder. Otherwise a stale runId paired with
        // a different selected group would open the wrong session tree.
        if (run.group_folder !== folder) {
          return this.json(res, 400, {
            error: 'run does not belong to this group',
          });
        }
        // Require a session_id on the run. Without it, the prior code path
        // fell back to getSession(folder) — the group's *current* session,
        // which may be a different agent's. That fallback is exactly the
        // cross-run / cross-agent context bleed #132 reported.
        if (!run.session_id) {
          return this.json(res, 404, {
            error: 'run has no session — transcript unavailable',
          });
        }
        const end = new Date(run.timestamp).getTime();
        const start = end - (run.duration_ms || 0);
        // Pad by 2s on the leading edge — the SDK timestamps the `result`
        // message when the run ends, and earlier tool_use entries may have
        // slightly earlier clock readings than duration_ms alone captures.
        runWindow = { start: start - 2000, end: end + 500 };
        runSessionId = run.session_id;
        runMeta = {
          id: run.id,
          timestamp: run.timestamp,
          duration_ms: run.duration_ms,
          cost_usd: run.cost_usd,
          num_turns: run.num_turns,
          session_id: run.session_id,
        };
      }

      const sessionId = runSessionId || getSession(folder);
      if (!sessionId) {
        return this.json(res, 404, { error: 'No active session' });
      }

      // Find transcript JSONL anywhere under the group's session dir. Older
      // single-agent sessions live at `{folder}/.claude/projects/...` while
      // multi-agent ones nest under `{folder}/{agent}/.claude/projects/...`.
      const sessionsBase = path.join(DATA_DIR, 'sessions', folder);
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
          // tool_call (paired) entries — filled in when the matching
          // tool_result lands. id ties the pair across the pendingCalls map.
          id?: string;
          args?: string;
          result?: string;
          status?: 'success' | 'error';
          duration_ms?: number;
          // user text entries — sender from the unwrapped <message> attrs
          sender?: string;
          [key: string]: unknown;
        }> = [];

        const inWindow = (ts: string | undefined): boolean => {
          if (!runWindow) return true;
          if (!ts) return false;
          const t = new Date(ts).getTime();
          return t >= runWindow.start && t <= runWindow.end;
        };

        const extractToolSummary = (
          input: Record<string, unknown> | undefined,
        ): string => {
          if (!input) return '';
          const s = (v: unknown, n: number): string =>
            String(v).split('\n')[0].slice(0, n);
          // Known-shape tools — preserve today's compact summaries
          if (input.command) return s(input.command, 120);
          if (input.file_path)
            return String(input.file_path).split(/[/\\]/).pop() ?? '';
          if (input.pattern) return s(input.pattern, 80);
          if (input.path) return s(input.path, 120);
          if (input.url) return s(input.url, 120);
          if (input.query) return s(input.query, 120);
          // mcp__* and other unrecognized shapes — JSON-stringify so the
          // summary line carries something rather than rendering as a bare
          // tool name. The full args still go in the expandable args field.
          try {
            const json = JSON.stringify(input);
            if (json && json !== '{}') {
              return json.length > 200 ? json.slice(0, 197) + '...' : json;
            }
          } catch {
            // unstringifiable inputs are rare; falling back to empty is fine
          }
          return '';
        };

        const stringifyArgs = (
          input: Record<string, unknown> | undefined,
        ): string => {
          if (!input) return '';
          try {
            const json = JSON.stringify(input, null, 2);
            // Cap at 4KB so transcript payloads stay bounded. UI can still
            // present this as expandable content without the old 500-char
            // hardcap that dropped long inputs entirely.
            return json.length > 4000 ? json.slice(0, 3997) + '...' : json;
          } catch {
            return '';
          }
        };

        const extractResultContent = (c: unknown): string => {
          let raw = '';
          if (typeof c === 'string') {
            raw = c;
          } else if (Array.isArray(c)) {
            raw = c
              .filter(
                (b: unknown): b is { type: string; text?: string } =>
                  typeof b === 'object' &&
                  b !== null &&
                  (b as { type: string }).type === 'text',
              )
              .map((b) => b.text ?? '')
              .join('');
          }
          // Cap at 4KB — old 500-char cap silently dropped Bash output and
          // long Read results past the boundary. The UI handles its own
          // scroll/expand on whatever the API returns.
          return raw.length > 4000 ? raw.slice(0, 3997) + '...' : raw;
        };

        // The orchestrator wraps inbound user text in a <messages> envelope
        // (one <message> per included history line). The old impl anchored
        // on </messages> and matched only the LAST <message>, dropping
        // earlier ones from multi-message envelopes. Iterate them all and
        // surface each as its own timeline entry (#136).
        const unwrapUserMessages = (
          raw: string,
        ): Array<{ text: string; sender?: string; time?: string }> => {
          const envelope = raw.match(/<messages>([\s\S]*?)<\/messages>/i);
          const inner = envelope ? envelope[1] : raw;
          const matches = [
            ...inner.matchAll(/<message\s+([^>]*)>([\s\S]*?)<\/message>/gi),
          ];
          if (matches.length === 0) {
            return [{ text: raw.trim() }];
          }
          return matches.map((m) => {
            const attrs = m[1];
            let body = m[2];
            // Strip the quoted_context wrapper from the displayed body —
            // it's noise in a per-message transcript view.
            body = body.replace(
              /<quoted_context>[\s\S]*?<\/quoted_context>/g,
              '',
            );
            const senderMatch = attrs.match(/sender="([^"]*)"/);
            const timeMatch = attrs.match(/time="([^"]*)"/);
            return {
              text: body.trim(),
              sender: senderMatch?.[1],
              time: timeMatch?.[1],
            };
          });
        };

        // Pending tool calls keyed by tool_use.id so a later tool_result can
        // be merged onto the same timeline entry. Carries the use timestamp
        // for the result-to-use duration calculation.
        const pendingCalls = new Map<
          string,
          { entry: Record<string, unknown>; useTs: string }
        >();
        // Track tool_use.id → tool name so out-of-order or orphaned
        // tool_result entries (no matching pending call) still get labeled.
        const toolNameById = new Map<string, string>();

        for (const entry of entries) {
          if (!inWindow(entry.timestamp)) continue;

          const content = entry.message?.content;
          if (!content) continue;

          if (entry.type === 'assistant' && Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'thinking' && block.thinking) {
                timeline.push({
                  type: 'thinking',
                  content: block.thinking.slice(0, 2000),
                  timestamp: entry.timestamp,
                });
              }
              if (block.type === 'text' && block.text) {
                timeline.push({
                  type: 'text',
                  role: 'assistant',
                  content: block.text.slice(0, 2000),
                  timestamp: entry.timestamp,
                });
              }
              if (block.type === 'tool_use') {
                if (block.id && block.name) {
                  toolNameById.set(block.id, block.name);
                }
                // tool_call is the paired shape — tool_result merges onto
                // this entry below when seen, filling status / result /
                // duration_ms. Entries that never see a matching result
                // (run aborted mid-call, etc.) render as pending.
                const callEntry = {
                  type: 'tool_call',
                  id: block.id,
                  tool: block.name,
                  summary: extractToolSummary(block.input),
                  args: stringifyArgs(block.input),
                  timestamp: entry.timestamp,
                };
                timeline.push(callEntry);
                if (block.id) {
                  pendingCalls.set(block.id, {
                    entry: callEntry as unknown as Record<string, unknown>,
                    useTs: entry.timestamp,
                  });
                }
              }
            }
          }

          const emitUserMessages = (raw: string): void => {
            for (const msg of unwrapUserMessages(raw)) {
              // SDK harness reminders ("[system] You completed tool calls
              // but did not send a visible reply...") are not user turns.
              if (!msg.text || msg.text.startsWith('[system]')) continue;
              timeline.push({
                type: 'text',
                role: 'user',
                content: msg.text.slice(0, 2000),
                sender: msg.sender,
                timestamp: msg.time || entry.timestamp,
              });
            }
          };

          if (entry.type === 'user') {
            if (typeof content === 'string') {
              emitUserMessages(content);
            } else if (Array.isArray(content)) {
              // User messages can carry either plain text (a real user turn)
              // or tool_result blocks (the agent's tool chain). Surface both.
              const textParts: string[] = [];
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  textParts.push(block.text);
                }
                if (block.type === 'tool_result') {
                  const useId = block.tool_use_id;
                  const pending = useId ? pendingCalls.get(useId) : undefined;
                  const result = extractResultContent(block.content);
                  const status: 'success' | 'error' = block.is_error
                    ? 'error'
                    : 'success';
                  if (pending) {
                    pending.entry.result = result;
                    pending.entry.status = status;
                    if (pending.useTs && entry.timestamp) {
                      pending.entry.duration_ms =
                        new Date(entry.timestamp).getTime() -
                        new Date(pending.useTs).getTime();
                    }
                    pendingCalls.delete(useId!);
                  } else {
                    // Orphaned tool_result — no matching tool_use seen.
                    // Emit as a standalone entry so the data isn't lost.
                    timeline.push({
                      type: 'tool_result',
                      tool:
                        (useId && toolNameById.get(useId)) || block.name || '',
                      content: result,
                      status,
                      timestamp: entry.timestamp,
                    });
                  }
                }
              }
              if (textParts.length) {
                emitUserMessages(textParts.join(''));
              }
            }
          }
        }

        return this.json(res, 200, { sessionId, timeline, run: runMeta });
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

    // GET /api/session/summary/:groupFolder — retrospective summary for reset dialog
    const summaryMatch = url.pathname.match(/^\/api\/session\/summary\/(.+)$/);
    if (method === 'GET' && summaryMatch) {
      const groupFolder = decodeURIComponent(summaryMatch[1]);
      const pressure = getSessionPressure(groupFolder);

      // Find JID for this group to query messages
      const entry = Object.entries(this.opts.registeredGroups()).find(
        ([, g]) => g.folder === groupFolder,
      );
      const jid = entry?.[0];
      const recentMessages = jid ? getSessionSummaryMessages(jid) : [];

      // Read current CLAUDE.md so user can see what's already persisted
      const group = entry?.[1];
      let claudeMd = '';
      if (group) {
        const agents = discoverAgents(group);
        const coordinator = agents.find((a) => !a.trigger) || agents[0];
        if (coordinator) {
          const mdPath = resolveAgentClaudeMdPath(coordinator);
          try {
            claudeMd = fs.readFileSync(mdPath, 'utf-8');
          } catch {
            // file may not exist yet
          }
        }
      }

      return this.json(res, 200, { pressure, recentMessages, claudeMd });
    }

    // POST /api/session/reflect/:groupFolder — AI-generated retrospective suggestions
    const reflectMatch = url.pathname.match(/^\/api\/session\/reflect\/(.+)$/);
    if (method === 'POST' && reflectMatch) {
      const groupFolder = decodeURIComponent(reflectMatch[1]);
      const entry = Object.entries(this.opts.registeredGroups()).find(
        ([, g]) => g.folder === groupFolder,
      );
      const jid = entry?.[0];
      const messages = jid ? getSessionSummaryMessages(jid, 30) : [];
      try {
        const { generateReflection } = await import('../session-reflection.js');
        const suggestions = await generateReflection(messages);
        return this.json(res, 200, {
          suggestions,
          debug: {
            groupFolder,
            jid: jid || null,
            messageCount: messages.length,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err: msg, groupFolder }, 'Session reflection failed');
        return this.json(res, 200, {
          suggestions: [],
          error: msg,
          debug: {
            groupFolder,
            jid: jid || null,
            messageCount: messages.length,
          },
        });
      }
    }

    // POST /api/session/reset/:groupFolder — reset session for a group
    const resetMatch = url.pathname.match(/^\/api\/session\/reset\/(.+)$/);
    if (method === 'POST' && resetMatch) {
      const groupFolder = decodeURIComponent(resetMatch[1]);
      if (!this.opts.onResetSession) {
        return this.json(res, 501, { error: 'Session reset not available' });
      }
      try {
        // If notes provided, append to CLAUDE.md before resetting
        const body = await this.readBody(req);
        const notes = body?.notes as string | undefined;
        if (notes && notes.trim()) {
          const entry = Object.entries(this.opts.registeredGroups()).find(
            ([, g]) => g.folder === groupFolder,
          );
          const group = entry?.[1];
          if (group) {
            const agents = discoverAgents(group);
            const coordinator = agents.find((a) => !a.trigger) || agents[0];
            if (coordinator) {
              const mdPath = resolveAgentClaudeMdPath(coordinator);
              const existing = fs.existsSync(mdPath)
                ? fs.readFileSync(mdPath, 'utf-8')
                : '';
              const dateStr = new Date().toISOString().split('T')[0];
              const section = `\n\n## Session Notes (${dateStr})\n\n${notes.trim()}\n`;
              fs.writeFileSync(mdPath, existing + section, 'utf-8');
              logger.info(
                { groupFolder, mdPath },
                'Appended session notes to CLAUDE.md',
              );
            }
          }
        }

        await this.opts.onResetSession(groupFolder);
        // Clear pressure signal for this group's JID
        const jid = Object.entries(this.opts.registeredGroups()).find(
          ([, g]) => g.folder === groupFolder,
        )?.[0];
        if (jid) {
          this.broadcast('context_pressure_cleared', { jid, groupFolder });
        }
        return this.json(res, 200, { ok: true, groupFolder });
      } catch (err) {
        return this.json(res, 500, {
          error: err instanceof Error ? err.message : 'Reset failed',
        });
      }
    }

    // GET /api/session/pressure — context pressure for all active groups
    if (method === 'GET' && url.pathname === '/api/session/pressure') {
      const hours = parseInt(url.searchParams.get('hours') || '24', 10);
      const pressure = getAllSessionPressure(hours);
      return this.json(res, 200, { sessions: pressure });
    }

    // GET /api/session/pressure/:groupFolder — context pressure for a specific group
    const pressureMatch = url.pathname.match(
      /^\/api\/session\/pressure\/(.+)$/,
    );
    if (method === 'GET' && pressureMatch) {
      const groupFolder = decodeURIComponent(pressureMatch[1]);
      const pressure = getSessionPressure(groupFolder);
      return this.json(res, 200, pressure);
    }

    // GET /api/telemetry — aggregated metrics
    if (method === 'GET' && url.pathname === '/api/telemetry') {
      const stats = getTelemetryStats();
      // Threshold unlocks broadcast via the registered achievement
      // broadcaster set up at startup — no need to fan out the SSE here.
      checkTelemetryAchievements(stats);
      return this.json(res, 200, stats);
    }

    // GET /api/achievements — achievement definitions + unlock state +
    // computed XP / level. State.xp is overridden with the live activity-driven
    // total so the HUD reflects ongoing usage, not just achievement unlocks.
    if (method === 'GET' && url.pathname === '/api/achievements') {
      const base = getAchievementResponse();
      const xp = computeXp();
      const levelInfo = levelFromXp(xp.total);
      return this.json(res, 200, {
        ...base,
        state: { ...base.state, xp: xp.total },
        xpBreakdown: xp,
        levelInfo,
      });
    }

    // GET /api/health — prerequisite check for first-boot onboarding
    if (method === 'GET' && url.pathname === '/api/health') {
      const health = await getHealthStatus();
      return this.json(res, 200, health);
    }

    // GET /api/auth-state — provider auth health snapshot
    if (method === 'GET' && url.pathname === '/api/auth-state') {
      return this.json(res, 200, {
        providers: {
          anthropic: getProviderAuthHealth('anthropic'),
          ollama: getProviderAuthHealth('ollama'),
        },
      });
    }

    // POST /api/auth-state/:provider/recheck — clear failure override and re-read auth state
    const authRecheckMatch = url.pathname.match(
      /^\/api\/auth-state\/([A-Za-z0-9_-]+)\/recheck$/,
    );
    if (method === 'POST' && authRecheckMatch) {
      const remote = req.socket.remoteAddress;
      if (
        remote !== '127.0.0.1' &&
        remote !== '::1' &&
        remote !== '::ffff:127.0.0.1'
      ) {
        return this.json(res, 403, { error: 'Localhost only' });
      }

      const provider = authRecheckMatch[1];
      if (provider !== 'anthropic' && provider !== 'ollama') {
        return this.json(res, 400, { error: 'Unsupported provider' });
      }

      return this.json(res, 200, {
        ok: true,
        health: recheckProviderAuth(provider),
      });
    }

    // POST /api/register-anthropic — register Anthropic API key in .env
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
        const { writeEnvVar } = await import('../env.js');
        writeEnvVar('ANTHROPIC_API_KEY', key);

        if (customEndpoint) {
          writeEnvVar('ANTHROPIC_BASE_URL', customEndpoint);
        }

        logger.info('Anthropic API key saved to .env');
        return this.json(res, 200, { ok: true });
      } catch (err) {
        logger.error({ err }, 'Failed to save Anthropic key');
        return this.json(res, 500, {
          error: 'Failed to save API key to .env',
        });
      }
    }

    // POST /api/register-credential — register any credential via IPC
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
      // picks it up, saves to .env, and writes the result file
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
    // The user-supplied clientId is informational only (logging/debug). The
    // map key is an internal per-connection UUID so two connections that
    // happen to share a clientId — common during reconnect races, multi-tab,
    // or proxy retries — can coexist without one's close handler evicting
    // the other from the broadcast set.
    const connId = randomUUID();
    const jidFilter = url.searchParams.get('jid') || undefined;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');

    this.sseClients.set(connId, { res, jid: jidFilter });

    // Keepalive
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 30000);

    req.on('close', () => {
      clearInterval(keepalive);
      this.sseClients.delete(connId);
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
