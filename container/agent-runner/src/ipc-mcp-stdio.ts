/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

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
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      agentId: process.env.NANOCLAW_AGENT_ID || undefined,
      sessionId: process.env.NANOCLAW_SESSION_ID || undefined,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
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

    const specNames = args.specialists.map((s) => s.displayName || s.name).join(', ');
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

Use this instead of asking the user to paste secrets into chat. The credential is stored in an encrypted vault and injected automatically into API calls.

Known services: atlassian, github, gitlab, launchdarkly. For other services, provide a custom service name and host_pattern.

This tool returns immediately after sending the credential request. The user will submit the credential asynchronously. Once registered, a confirmation message is sent to the chat. You can proceed with other work in the meantime.`,
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

    // Web UI — send IPC task to open browser popup (non-blocking)
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

    return {
      content: [
        {
          type: 'text' as const,
          text: `A secure credential form for "${args.service}" has been sent to the browser. ` +
            `The user will enter their secret there — you will never see it. ` +
            `A confirmation message will appear in the chat once the credential is registered. ` +
            `You can continue with other work in the meantime.`,
        },
      ],
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

The target agent's response will appear in the chat. You do NOT need to wait for their response — it will arrive after your turn completes.

Example: delegate_to_agent({ agent: "analyst", message: "Please analyze the three jokes I just told and rate them." })`,
    {
      agent: z.string().describe('Name of the target agent (e.g. "analyst", "greeter"). Must be an agent in this group.'),
      message: z.string().describe('Instructions or context for the target agent. Be specific about what you want them to do.'),
    },
    async (args) => {
      const DELEGATIONS_DIR = path.join(IPC_DIR, 'delegations');
      writeIpcFile(DELEGATIONS_DIR, {
        type: 'delegate',
        targetAgent: args.agent,
        message: args.message,
        sourceAgent: process.env.NANOCLAW_AGENT_NAME || 'default',
        sourceAgentId: process.env.NANOCLAW_AGENT_ID || '',
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
