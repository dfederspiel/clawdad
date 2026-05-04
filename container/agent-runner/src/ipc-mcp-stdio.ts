/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Keep in sync with MIN_DELEGATION_MESSAGE_LENGTH in src/delegation-validation.ts.
// Container is a separate TS project so we can't import from the host code.
const MIN_DELEGATION_MESSAGE_LENGTH = 40;

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';
const mainJid = process.env.NANOCLAW_MAIN_JID || '';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

function ensureGroupWorkspacePath(filePath: string): string | null {
  if (!filePath.startsWith('/workspace/group/')) {
    return null;
  }
  const relative = path.relative('/workspace/group', filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return filePath;
}

function publishMediaRequest(args: {
  path: string;
  caption?: string;
  alt?: string;
  threadId?: string;
  source?: 'agent_browser' | 'agent_output' | 'user_upload';
}): void {
  writeIpcFile(MESSAGES_DIR, {
    type: 'publish_media',
    chatJid,
    containerPath: args.path,
    caption: args.caption || undefined,
    alt: args.alt || undefined,
    threadId: args.threadId || undefined,
    sender: process.env.NANOCLAW_AGENT_NAME || undefined,
    source: args.source || 'agent_browser',
    groupFolder,
    agentId: process.env.NANOCLAW_AGENT_ID || undefined,
    sessionId: process.env.NANOCLAW_SESSION_ID || undefined,
    timestamp: new Date().toISOString(),
  });
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    // If this run is portal-scoped (delegation/action button/open_portal),
    // tag the message so the host routes it to the side panel instead of
    // the main feed. Empty env var = main-feed message (#107).
    const portalThreadId = process.env.NANOCLAW_PORTAL_THREAD_ID || '';
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      agentId: process.env.NANOCLAW_AGENT_ID || undefined,
      sessionId: process.env.NANOCLAW_SESSION_ID || undefined,
      threadId: portalThreadId || undefined,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'publish_media',
  `Publish an image from /workspace/group/ into the web chat thread. Use this when you want the user to see a screenshot or visual artifact inline in the conversation.

Important:
- The file MUST already exist under /workspace/group/
- This is currently intended for the web UI
- Prefer a dedicated subdirectory like /workspace/group/artifacts/screenshots/ instead of cluttering the group root
- For screenshots, save them under /workspace/group/artifacts/screenshots/ first, then call publish_media`,
  {
    path: z.string().describe('Absolute path to a file under /workspace/group/ (for example /workspace/group/artifacts/screenshots/debug.png).'),
    caption: z.string().optional().describe('Optional user-facing caption to show above the media.'),
    alt: z.string().optional().describe('Optional alt text describing the image for accessibility and context.'),
    thread_id: z.string().optional().describe('Optional thread ID when publishing inside a thread.'),
  },
  async (args) => {
    if (!ensureGroupWorkspacePath(args.path)) {
      return {
        content: [{
          type: 'text' as const,
          text: 'publish_media only supports files under /workspace/group/ in phase 1.',
        }],
        isError: true,
      };
    }

    const ext = args.path.toLowerCase().match(/\.(png|jpg|jpeg|gif|webp)$/);
    if (!ext) {
      return {
        content: [{
          type: 'text' as const,
          text: 'publish_media only supports image files (.png, .jpg, .jpeg, .gif, .webp) in phase 1. PDFs and other media are not yet renderable in chat.',
        }],
        isError: true,
        };
      }

    publishMediaRequest({
      path: args.path,
      caption: args.caption || undefined,
      alt: args.alt || undefined,
      threadId: args.thread_id || undefined,
      source: 'agent_browser',
    });

    return {
      content: [{ type: 'text' as const, text: 'Media published to chat.' }],
    };
  },
);

server.tool(
  'publish_browser_snapshot',
  `Capture the current browser view with agent-browser and publish it into the web chat thread. Use this when visual context would help the user confirm what you are seeing.

This is the fastest way to show the user a browser screenshot:
- It saves the image under /workspace/group/artifacts/screenshots/
- It publishes the screenshot inline to the web chat
- Prefer this over manual screenshot + publish_media when you just need a quick visual snapshot

Especially useful when:
- The user asks "show me", "what do you see?", or requests a screenshot
- Browser work is blocked by a login wall, captcha, permission prompt, modal trap, missing control, or broken layout`,
  {
    filename: z.string().optional().describe('Optional filename like "login-state.png". Defaults to a timestamped name under /workspace/group/artifacts/screenshots/.'),
    caption: z.string().optional().describe('Optional user-facing caption for the screenshot.'),
    alt: z.string().optional().describe('Optional alt text describing the screenshot.'),
    full_page: z.boolean().optional().describe('Capture the full page instead of just the viewport.'),
    thread_id: z.string().optional().describe('Optional thread ID when publishing inside a thread.'),
  },
  async (args) => {
    const screenshotsDir = '/workspace/group/artifacts/screenshots';
    fs.mkdirSync(screenshotsDir, { recursive: true });

    const requestedName = (args.filename || '').trim();
    const safeName = requestedName
      ? path.basename(requestedName).replace(/[^A-Za-z0-9._-]/g, '-')
      : `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    const filename = /\.(png|jpg|jpeg|gif|webp)$/i.test(safeName)
      ? safeName
      : `${safeName}.png`;
    const outputPath = path.join(screenshotsDir, filename);

    const screenshotArgs = ['screenshot'];
    if (args.full_page) {
      screenshotArgs.push('--full');
    }
    screenshotArgs.push(outputPath);

    try {
      execFileSync('agent-browser', screenshotArgs, {
        cwd: '/workspace/group',
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      return {
        content: [{
          type: 'text' as const,
          text: `Failed to capture browser snapshot: ${details}`,
        }],
        isError: true,
      };
    }

    publishMediaRequest({
      path: outputPath,
      caption: args.caption || undefined,
      alt: args.alt || undefined,
      threadId: args.thread_id || undefined,
      source: 'agent_browser',
    });

    return {
      content: [{
        type: 'text' as const,
        text: `Browser snapshot published from ${outputPath}.`,
      }],
    };
  },
);

// escalate: non-main agents can send a message to the main/general group.
// Main agents already have cross-group messaging via send_message.
if (!isMain && mainJid) {
  server.tool(
    'escalate',
    'Send a message to the main group (General). Use this to report findings, escalate issues, or deliver results from cross-group tasks. The message appears in the General chat.',
    {
      text: z.string().describe('The message to send to the main group'),
    },
    async (args) => {
      const data: Record<string, string | undefined> = {
        type: 'message',
        chatJid: mainJid,
        text: `[From ${groupFolder}] ${args.text}`,
        sender: undefined,
        groupFolder,
        agentId: process.env.NANOCLAW_AGENT_ID || undefined,
        sessionId: process.env.NANOCLAW_SESSION_ID || undefined,
        timestamp: new Date().toISOString(),
      };

      writeIpcFile(MESSAGES_DIR, data);

      return { content: [{ type: 'text' as const, text: 'Message sent to main group.' }] };
    },
  );
}

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    title: z.string().optional().describe('Short display title for the task (e.g., "Daily standup report"). Auto-generated from prompt if omitted.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
    script: z.string().optional().describe('Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      title: args.title || undefined,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
    script: z.string().optional().describe('New script for the task. Set to empty string to remove the script.'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new agent group. Main group only.

For web agents: use JID "web:{name}" and folder "web_{name}" (e.g., jid: "web:weather", folder: "web_weather", trigger: "@Andy").

For messaging channels: use available_groups.json to find the JID. Folder must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general").

After registering, write a CLAUDE.md in the new group's folder with the agent's persona and instructions.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'register_team',
  `Create a multi-agent team (coordinator + specialists). Main group only.

Creates the full agents/ directory structure with CLAUDE.md and agent.json for each agent. The coordinator handles untriggered messages and delegates to specialists. Specialists respond when @-mentioned or delegated to.

Example:
  name: "Research Team"
  folder: "research-team"
  coordinator: { displayName: "Coordinator", instructions: "# Coordinator\\n\\nYou coordinate research tasks..." }
  specialists: [{ name: "analyst", displayName: "Analyst", trigger: "@analyst", instructions: "# Analyst\\n\\nYou analyze data..." }]`,
  {
    name: z.string().describe('Team display name'),
    folder: z.string().describe('Folder name (alphanumeric, underscores, dashes, max 64 chars)'),
    coordinator: z.object({
      name: z.string().optional().describe('Agent code name (default: "coordinator")'),
      displayName: z.string().optional().describe('Human-readable name (default: "Coordinator")'),
      instructions: z.string().optional().describe('Full CLAUDE.md content for the coordinator'),
    }).describe('Coordinator agent config'),
    specialists: z.array(z.object({
      name: z.string().describe('Agent code name (e.g., "analyst")'),
      displayName: z.string().optional().describe('Human-readable name'),
      trigger: z.string().describe('Trigger pattern (e.g., "@analyst")'),
      instructions: z.string().optional().describe('Full CLAUDE.md content for the specialist'),
    })).describe('Specialist agents (at least one required)'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can create teams.' }],
        isError: true,
      };
    }

    if (!args.specialists || args.specialists.length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'At least one specialist is required.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_team',
      name: args.name,
      folder: args.folder,
      coordinator: args.coordinator,
      specialists: args.specialists,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const specNames = args.specialists.map((s: any) => s.displayName || s.name).join(', ');
    return {
      content: [{ type: 'text' as const, text: `Team "${args.name}" created with coordinator + specialists: ${specNames}. It will appear in the sidebar immediately.` }],
    };
  },
);

const ACHIEVEMENTS_DIR = path.join(IPC_DIR, 'achievements');

// Build achievement list dynamically from host-provided data (via ContainerInput)
const achievementList: { id: string; name: string; description: string }[] = (() => {
  try {
    return JSON.parse(process.env.NANOCLAW_ACHIEVEMENTS || '[]');
  } catch {
    return [];
  }
})();

const achievementDocstring = achievementList.length > 0
  ? achievementList.map((a) => `- ${a.id}: ${a.description}`).join('\n')
  : '(No achievements configured)';

server.tool(
  'unlock_achievement',
  `Unlock a gamification achievement for the user. Call this when the user experiences a feature for the first time. Each achievement can only be unlocked once — duplicates are silently ignored.

Available achievement IDs:
${achievementDocstring}`,
  {
    achievement_id: z.string().describe('The achievement ID to unlock'),
  },
  async (args) => {
    const data = {
      type: 'achievement',
      achievementId: args.achievement_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(ACHIEVEMENTS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Achievement "${args.achievement_id}" unlock requested.` }],
    };
  },
);

// --- Credential request (triggers browser popup — agent never sees the secret) ---

const CREDENTIALS_DIR = path.join(IPC_DIR, 'credentials');

server.tool(
  'request_credential',
  `Request the user to register a credential. In web UI groups (chatJid starts with "web:"), this opens a secure popup in the browser — the user enters the secret directly, you never see it. For non-web channels, falls back to register-credential.sh.

Use this instead of asking the user to paste secrets into chat. The credential is stored in the vault and injected automatically by the credential proxy into API calls made via api.sh or cred-exec.sh.

Known services: atlassian, github, gitlab, launchdarkly. For other services, provide a custom service name and host_pattern.

This tool BLOCKS until the user submits the credential (up to 2 minutes). On success it returns the env var name and usage instructions. You do NOT need to poll or wait separately — the result tells you everything you need to proceed.

IMPORTANT: After registration, use api.sh or cred-exec.sh for all API calls. Do NOT use raw curl with env vars — they contain proxy placeholders, not real credentials.`,
  {
    service: z.string().describe('Service name (e.g., "atlassian", "github", "gitlab", "launchdarkly", or a custom name)'),
    host_pattern: z.string().optional().describe('Host pattern for the credential (e.g., "*.atlassian.net"). Uses service default if omitted.'),
    description: z.string().describe('Why this credential is needed — shown to the user in the popup'),
    email: z.string().optional().describe('Email address (required for Atlassian Basic auth)'),
  },
  async (args) => {
    const isWebChannel = chatJid.startsWith('web:');

    if (!isWebChannel) {
      // Non-web channel (CLI, Telegram, etc.) — no browser popup available.
      // Tell the agent to use the CLI fallback instead.
      return {
        content: [
          {
            type: 'text' as const,
            text: `Cannot open a credential popup — this group is not running in the web UI (channel: ${chatJid}). ` +
              `Use the CLI fallback instead:\n\n` +
              `/workspace/scripts/register-credential.sh ${args.service} "TOKEN_VALUE"${args.email ? ` --email "${args.email}"` : ''}${args.host_pattern ? ` --host-pattern "${args.host_pattern}"` : ''} --wait\n\n` +
              `Ask the user to provide the token in chat, then call register-credential.sh immediately. Never store the token in a file.`,
          },
        ],
      };
    }

    // Web UI — send IPC task to open browser popup, then poll for result
    writeIpcFile(TASKS_DIR, {
      type: 'request_credential',
      service: args.service,
      hostPattern: args.host_pattern,
      description: args.description,
      email: args.email,
      groupFolder,
      chatJid,
      timestamp: new Date().toISOString(),
    });

    // Poll for the result file (written by the host after the user submits)
    const resultPath = path.join(CREDENTIALS_DIR, `result-${args.service}.json`);
    const POLL_INTERVAL_MS = 2000;
    const TIMEOUT_MS = 120000; // 2 minutes
    const startTime = Date.now();

    // Remove any stale result file from a previous request
    try { fs.unlinkSync(resultPath); } catch { /* ignore */ }

    while (Date.now() - startTime < TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      try {
        const raw = fs.readFileSync(resultPath, 'utf-8');
        const result = JSON.parse(raw);
        // Clean up result file
        try { fs.unlinkSync(resultPath); } catch { /* ignore */ }

        if (result.success) {
          const envName = result.envName || `${args.service.toUpperCase()}_TOKEN`;
          return {
            content: [{
              type: 'text' as const,
              text: `Credential "${args.service}" registered successfully.\n\n` +
                `Environment variable: ${envName}\n` +
                `Use \`api.sh ${args.service} GET <url>\` for HTTP API calls.\n` +
                `Use \`cred-exec.sh ${args.service} ${envName} -- <command>\` for CLI tools.\n\n` +
                `IMPORTANT: Do NOT use raw curl with the env var directly — it contains a placeholder. ` +
                `The credential proxy injects the real value at request time. Always use api.sh or cred-exec.sh.`,
            }],
          };
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: `Credential registration for "${args.service}" failed: ${result.message}`,
            }],
          };
        }
      } catch {
        // Result file not yet written — keep polling
      }
    }

    // Timeout — user didn't submit within 2 minutes
    return {
      content: [{
        type: 'text' as const,
        text: `The credential popup for "${args.service}" timed out after 2 minutes — the user may not have submitted it. ` +
          `Ask the user if they need help, then try again if needed.`,
      }],
    };
  },
);

server.tool(
  'play_sound',
  `Play a notification sound in the user's web UI. Use this to signal events:
- Task completion → "treasure" or "levelup"
- Something needs attention → "encounter" or "radar"
- Success → "secret" or "powerup"
- Failure → "gameover"
- Progress milestone → "coin" or "chime"

Available tones: chime, droplet, whisper, dewdrop, bubble, ping, sparkle, twinkle, coin, bell, melody, harp, celeste, marimba, doorbell, lullaby, pulse, click, radar, sonar, tap, treasure, secret, powerup, levelup, oneup, gameover, encounter, glow, breeze, aurora.

Or provide a custom composition with an array of note objects.`,
  {
    tone: z.string().optional().describe('Named tone from the library (e.g., "treasure", "levelup", "encounter")'),
    custom: z.array(z.object({
      freq: z.number().describe('Frequency in Hz'),
      endFreq: z.number().optional().describe('End frequency for sweep'),
      duration: z.number().optional().describe('Duration in seconds (default 0.15)'),
      type: z.enum(['sine', 'triangle', 'square', 'sawtooth']).optional().describe('Waveform type'),
      gain: z.number().optional().describe('Volume 0-1 (default 0.2)'),
      delay: z.number().optional().describe('Delay before playing in seconds'),
    })).optional().describe('Custom composition — array of notes to play'),
    label: z.string().optional().describe('Display label shown in the chat (e.g., "Deploy complete!")'),
  },
  async (args) => {
    // Write IPC task for the host to broadcast as SSE
    writeIpcFile(TASKS_DIR, {
      type: 'play_sound',
      tone: args.tone,
      custom: args.custom,
      label: args.label,
      chatJid,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{
        type: 'text' as const,
        text: `Sound "${args.tone || 'custom'}" sent to the UI.`,
      }],
    };
  },
);

server.tool(
  'set_subtitle',
  `Set a status line that appears under your group name in the sidebar. Use this to show what you're currently working on, waiting for, or monitoring. Examples:
- "Monitoring 3 PRs for review"
- "Waiting for deploy to complete"
- "Analyzing 142 test results"
Set to empty string to clear.`,
  {
    subtitle: z.string().describe('Status text to show under the group name in the sidebar. Empty string clears it.'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'set_subtitle',
      subtitle: args.subtitle,
      chatJid,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{
        type: 'text' as const,
        text: args.subtitle ? `Subtitle set to: "${args.subtitle}"` : 'Subtitle cleared.',
      }],
    };
  },
);

server.tool(
  'set_agent_status',
  `Set a status line for your own agent row in the expanded group sidebar. Use this for concise updates like:
- "Reviewing flags"
- "Waiting on build"
- "Drafting summary"
Set to empty string to clear.`,
  {
    status: z
      .string()
      .describe(
        'Short status text to show under your agent name in the sidebar. Empty string clears it.',
      ),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'set_agent_status',
      status: args.status,
      chatJid,
      groupFolder,
      agentId: process.env.NANOCLAW_AGENT_ID || undefined,
      agentName: process.env.NANOCLAW_AGENT_NAME || undefined,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: args.status
            ? `Agent status set to: "${args.status}"`
            : 'Agent status cleared.',
        },
      ],
    };
  },
);

// Only coordinators (agents without triggers) can delegate to other agents.
// Specialists should hand back to the coordinator via their output text.
if (process.env.NANOCLAW_CAN_DELEGATE === '1') {
  server.tool(
    'delegate_to_agent',
    `Delegate a task to another agent in this group. The target agent runs in its own container with the full conversation context plus your instructions. Use this when work falls outside your role.

The target agent runs after your turn completes. Their user-visible response may be suppressed if newer context arrives before delivery, but the coordinator still gets a system note that they finished.

By default you get a follow-up turn after the specialist replies — use it to acknowledge, synthesize, or hand off to the next agent. Pick "final_response" only when the specialist's own output IS the final answer to the user and you have nothing to add.

Example: delegate_to_agent({ agent: "analyst", message: "Please analyze the three jokes I just told and rate them." })`,
    {
      agent: z.string().describe('Name of the target agent (e.g. "analyst", "greeter"). Must be an agent in this group.'),
      message: z.string().describe('Instructions or context for the target agent. Be specific about what you want them to do.'),
      completion_policy: z.enum(['final_response', 'retrigger_coordinator']).default('retrigger_coordinator').describe('What happens after the specialist responds. "retrigger_coordinator" (default): you get a follow-up turn to acknowledge, synthesize, or continue the conversation. Choose this whenever you might want to respond to the user after the specialist replies. "final_response": the specialist\'s output IS the final answer — you will NOT get a follow-up turn. Use this only for true fire-and-forget handoffs where you have nothing to add.'),
    },
    async (args) => {
      // Platform-level validation (#48): specialists see only this message,
      // not the coordinator's conversation. Reject obviously insufficient
      // payloads so the coordinator can self-correct instead of wasting a
      // ~30-60s specialist container startup on an empty prompt.
      const trimmedMessage = (args.message ?? '').trim();
      if (trimmedMessage.length < MIN_DELEGATION_MESSAGE_LENGTH) {
        return {
          isError: true,
          content: [{
            type: 'text' as const,
            text: `Delegation rejected: message is too short (${trimmedMessage.length} chars, minimum ${MIN_DELEGATION_MESSAGE_LENGTH}). The target agent runs in its own container and sees ONLY this message — they do not have your conversation history. Retry the tool call with: what you specifically need, any context (ticket IDs, paths, prior findings), and the expected output format.`,
          }],
        };
      }

      const DELEGATIONS_DIR = path.join(IPC_DIR, 'delegations');
      writeIpcFile(DELEGATIONS_DIR, {
        type: 'delegate',
        targetAgent: args.agent,
        message: args.message,
        completionPolicy: args.completion_policy || 'retrigger_coordinator',
        sourceAgent: process.env.NANOCLAW_AGENT_NAME || 'default',
        sourceAgentId: process.env.NANOCLAW_AGENT_ID || '',
        sourceBatchId: process.env.NANOCLAW_RUN_BATCH_ID || '',
        sourceSessionId: process.env.NANOCLAW_SESSION_ID || '',
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      });

      return {
        content: [{
          type: 'text' as const,
          text: `Delegated to ${args.agent}. They will respond in the chat.`,
        }],
      };
    },
  );
}

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
