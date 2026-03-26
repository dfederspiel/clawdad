import http from 'http';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { WEB_UI_PORT, WEB_UI_ENABLED, ASSISTANT_NAME } from '../config.js';
import {
  getMessagesSince,
  storeMessageDirect,
  getAllTasks,
  getTaskById,
  getTaskRunLogs,
  updateTask,
  deleteTask,
  getTelemetryStats,
} from '../db.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, NewMessage, RegisteredGroup } from '../types.js';

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
  }

  async connect(): Promise<void> {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    return new Promise((resolve, reject) => {
      this.server!.listen(WEB_UI_PORT, () => {
        logger.info({ port: WEB_UI_PORT }, 'Web UI channel started');
        resolve();
      });
      this.server!.on('error', reject);
    });
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

  async sendMessage(jid: string, text: string): Promise<void> {
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
    });

    this.broadcast('message', { jid, text, timestamp });
    logger.info({ jid, length: text.length }, 'Web message sent');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    this.broadcast('typing', { jid, isTyping });
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
        .map(([jid, g]) => ({ jid, name: g.name, folder: g.folder, isMain: g.isMain }));
      return this.json(res, 200, { groups: webGroups });
    }

    // POST /api/groups — register a new web group
    if (method === 'POST' && url.pathname === '/api/groups') {
      const body = await this.readBody(req);
      const { name, folder } = body;
      if (!name || !folder) {
        return this.json(res, 400, { error: 'name and folder are required' });
      }
      // Validate folder name (alphanumeric, underscores, dashes)
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(folder)) {
        return this.json(res, 400, {
          error: 'folder must be alphanumeric with underscores/dashes, max 64 chars',
        });
      }
      const jid = `web:${folder}`;
      const existing = this.opts.registeredGroups();
      if (existing[jid]) {
        return this.json(res, 409, { error: 'Group already exists', jid });
      }
      const group: RegisteredGroup = {
        name,
        folder: `web_${folder}`,
        trigger: `@${ASSISTANT_NAME}`,
        added_at: new Date().toISOString(),
        requiresTrigger: false, // Web groups don't need @mention
      };
      this.opts.onRegisterGroup?.(jid, group);
      // Store chat metadata
      this.opts.onChatMetadata(jid, new Date().toISOString(), name, 'web', true);
      return this.json(res, 201, { jid, group });
    }

    // GET /api/messages/:jid — message history
    const messagesMatch = url.pathname.match(/^\/api\/messages\/(.+)$/);
    if (method === 'GET' && messagesMatch) {
      const jid = decodeURIComponent(messagesMatch[1]);
      const since = url.searchParams.get('since') || '1970-01-01T00:00:00.000Z';
      const limit = parseInt(url.searchParams.get('limit') || '100', 10);
      const messages = getMessagesSince(jid, since, ASSISTANT_NAME, limit, true);
      return this.json(res, 200, { messages });
    }

    // POST /api/send — send a message to a web group
    if (method === 'POST' && url.pathname === '/api/send') {
      const body = await this.readBody(req);
      const { jid, content, sender } = body;
      if (!jid || !content) {
        return this.json(res, 400, { error: 'jid and content are required' });
      }
      if (content.length > 8000) {
        return this.json(res, 400, { error: 'Message too long (max 8000 chars)' });
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
      };

      // Deliver to orchestrator (same path as Discord/Gmail)
      this.opts.onMessage(jid, msg);

      // Echo back to all connected browsers so the sender sees their message
      this.broadcast('user_message', {
        jid,
        message: msg,
      });

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

    // GET /api/telemetry — aggregated metrics
    if (method === 'GET' && url.pathname === '/api/telemetry') {
      return this.json(res, 200, getTelemetryStats());
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
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(content);
    } catch {
      this.json(res, 404, { error: 'Not found' });
    }
  }

  // --- Helpers ---

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
