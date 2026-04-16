import fs from 'fs';
import path from 'path';

import {
  HookCallback,
  PreCompactHookInput,
  query,
} from '@anthropic-ai/claude-agent-sdk';

import {
  AgentRuntimeConfig,
  RuntimeCapabilityProfile,
  RuntimeEvent,
  RuntimeSession,
  RuntimeTurnInput,
  RuntimeUsageData,
} from './runtime-interface.js';

interface ContainerInputLike {
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  assistantName?: string;
  agentId?: string;
  agentName?: string;
  runBatchId?: string;
  canDelegate?: boolean;
  mainChatJid?: string;
  achievements?: { id: string; name: string; description: string }[];
  runtime?: AgentRuntimeConfig;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
      this.waiting = null;
    }
  }
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    return entry?.summary || null;
  } catch {
    return null;
  }
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const text = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text)
          .join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      // ignore malformed transcript lines
    }
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000 ? `${msg.content.slice(0, 2000)}...` : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);
      if (messages.length === 0) return {};

      const summary = sessionId
        ? getSessionSummary(sessionId, transcriptPath)
        : null;
      const name = summary
        ? sanitizeFilename(summary)
        : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filePath = path.join(conversationsDir, `${date}-${name}.md`);
      const markdown = formatTranscriptMarkdown(
        messages,
        summary,
        assistantName,
      );
      fs.writeFileSync(filePath, markdown);
    } catch {
      // ignore archival failures for now
    }

    return {};
  };
}

function summarizeTool(name: string, input?: Record<string, unknown>): string {
  if (!input) return name;
  switch (name) {
    case 'Bash': {
      const cmd = String(input.command || '')
        .split('\n')[0]
        .slice(0, 80);
      return cmd || 'Running command';
    }
    case 'Read':
      return (
        String(input.file_path || '').split(/[/\\]/).pop() || 'Reading file'
      );
    case 'Write':
      return `Writing ${
        String(input.file_path || '').split(/[/\\]/).pop() || 'file'
      }`;
    case 'Edit':
      return `Editing ${
        String(input.file_path || '').split(/[/\\]/).pop() || 'file'
      }`;
    case 'Glob':
      return `Finding ${String(input.pattern || 'files')}`;
    case 'Grep':
      return `Searching for "${String(input.pattern || '').slice(0, 40)}"`;
    case 'WebSearch':
      return `Searching: ${String(input.query || '').slice(0, 50)}`;
    case 'WebFetch':
      return `Fetching ${String(input.url || '').slice(0, 60)}`;
    case 'TodoWrite':
      return 'Updating tasks';
    case 'Task':
    case 'TaskOutput':
      return 'Managing tasks';
    case 'TeamCreate':
    case 'SendMessage':
      return 'Coordinating agents';
    default:
      if (name.startsWith('mcp__')) {
        const parts = name.split('__');
        return parts[parts.length - 1].replace(/_/g, ' ');
      }
      return name.replace(/_/g, ' ');
  }
}

export class ClaudeCodeRuntime implements RuntimeSession {
  provider = 'anthropic' as const;

  capabilities: RuntimeCapabilityProfile = {
    provider: 'anthropic',
    textInput: 'native',
    imageInput: 'native',
    localImageFileInput: 'sdk-dependent',
    remoteImageUrlInput: 'native',
    base64ImageInput: 'native',
    toolUse: 'native',
    streamingText: 'native',
    sessionResume: 'native',
    notes: [
      'Runs through the Claude Code SDK.',
      'This is the current production adapter boundary for Anthropic-backed execution.',
    ],
  };

  constructor(
    private readonly options: {
      containerInput: ContainerInputLike;
      mcpServerPath: string;
      sdkEnv: Record<string, string | undefined>;
      sessionId?: string;
      resumeAt?: string;
      log?: (message: string) => void;
      shouldClose: () => boolean;
      drainIpcInput: () => string[];
      ipcPollMs: number;
    },
  ) {}

  private log(message: string): void {
    this.options.log?.(message);
  }

  async *runTurn(input: RuntimeTurnInput): AsyncIterable<RuntimeEvent> {
    const prompt = input.messages
      .flatMap((message) =>
        message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text),
      )
      .join('\n');
    const stream = new MessageStream();
    stream.push(prompt);

    let ipcPolling = true;
    let closedDuringQuery = false;
    const pollIpcDuringQuery = () => {
      if (!ipcPolling) return;
      if (this.options.shouldClose()) {
        this.log('Close sentinel detected during query, ending stream');
        closedDuringQuery = true;
        stream.end();
        ipcPolling = false;
        return;
      }
      const messages = this.options.drainIpcInput();
      for (const text of messages) {
        this.log(`Piping IPC message into active query (${text.length} chars)`);
        stream.push(text);
      }
      setTimeout(pollIpcDuringQuery, this.options.ipcPollMs);
    };
    setTimeout(pollIpcDuringQuery, this.options.ipcPollMs);

    let newSessionId = this.options.sessionId;
    let lastAssistantUuid: string | undefined;
    let resultCount = 0;
    let nullResultRetries = 0;
    const assistantTexts: string[] = [];
    let lastTurnHadTools = false;
    const accumulatedUsage: RuntimeUsageData = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      durationMs: 0,
      durationApiMs: 0,
      numTurns: 0,
    };

    const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
    let globalClaudeMd: string | undefined;
    if (
      !this.options.containerInput.isMain &&
      fs.existsSync(globalClaudeMdPath)
    ) {
      globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
    }

    const extraDirs: string[] = [];
    const extraBase = '/workspace/extra';
    if (fs.existsSync(extraBase)) {
      for (const entry of fs.readdirSync(extraBase)) {
        const fullPath = path.join(extraBase, entry);
        if (fs.statSync(fullPath).isDirectory()) {
          extraDirs.push(fullPath);
        }
      }
    }

    const modelOverride =
      this.options.containerInput.runtime?.model ||
      process.env.CLAUDE_MODEL ||
      undefined;

    for await (const message of query({
      prompt: stream,
      options: {
        model: modelOverride,
        cwd: '/workspace/group',
        additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
        resume: this.options.sessionId,
        resumeSessionAt: this.options.resumeAt,
        systemPrompt: globalClaudeMd
          ? {
              type: 'preset' as const,
              preset: 'claude_code' as const,
              append: globalClaudeMd,
            }
          : undefined,
        allowedTools: [
          'Bash',
          'Read',
          'Write',
          'Edit',
          'Glob',
          'Grep',
          'WebSearch',
          'WebFetch',
          'Task',
          'TaskOutput',
          'TaskStop',
          'TeamCreate',
          'TeamDelete',
          'SendMessage',
          'TodoWrite',
          'ToolSearch',
          'Skill',
          'NotebookEdit',
          'mcp__nanoclaw__*',
          'mcp__ollama__*',
        ],
        env: this.options.sdkEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: {
          nanoclaw: {
            command: 'node',
            args: [this.options.mcpServerPath],
            env: {
              NANOCLAW_CHAT_JID: this.options.containerInput.chatJid,
              NANOCLAW_GROUP_FOLDER: this.options.containerInput.groupFolder,
              NANOCLAW_IS_MAIN: this.options.containerInput.isMain ? '1' : '0',
              NANOCLAW_AGENT_NAME:
                this.options.containerInput.agentName || 'default',
              NANOCLAW_AGENT_ID: this.options.containerInput.agentId || '',
              NANOCLAW_RUN_BATCH_ID:
                this.options.containerInput.runBatchId || '',
              NANOCLAW_SESSION_ID: this.options.sessionId || '',
              NANOCLAW_CAN_DELEGATE: this.options.containerInput.canDelegate
                ? '1'
                : '0',
              NANOCLAW_MAIN_JID: this.options.containerInput.mainChatJid || '',
              NANOCLAW_ACHIEVEMENTS: JSON.stringify(
                this.options.containerInput.achievements || [],
              ),
            },
          },
          ollama: {
            command: 'node',
            args: [
              path.join(
                path.dirname(this.options.mcpServerPath),
                'ollama-mcp-stdio.js',
              ),
            ],
          },
        },
        hooks: {
          PreCompact: [
            {
              hooks: [
                createPreCompactHook(
                  this.options.containerInput.assistantName,
                ),
              ],
            },
          ],
        },
      },
    })) {
      if (message.type === 'assistant' && 'uuid' in message) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
        if (lastTurnHadTools) {
          yield {
            type: 'progress',
            summary: 'Thinking...',
            timestamp: new Date().toISOString(),
          };
        }
        lastTurnHadTools = false;
        const assistantMsg = message as {
          message?: {
            content?: {
              type: string;
              text?: string;
              name?: string;
              input?: Record<string, unknown>;
            }[];
          };
        };
        if (assistantMsg.message?.content) {
          for (const block of assistantMsg.message.content) {
            if (block.type === 'text' && block.text) {
              assistantTexts.push(block.text);
              yield {
                type: 'text',
                text: block.text,
                timestamp: new Date().toISOString(),
              };
            }
            if (block.type === 'tool_use' && block.name) {
              lastTurnHadTools = true;
              yield {
                type: 'progress',
                tool: block.name,
                summary: summarizeTool(block.name, block.input),
                timestamp: new Date().toISOString(),
              };
            }
          }
        }
      }

      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
      }

      if (message.type === 'result') {
        resultCount++;
        const msg = message as Record<string, unknown>;
        const textResult = typeof msg.result === 'string' ? msg.result : null;
        const usage = msg.usage as
          | {
              input_tokens?: number;
              output_tokens?: number;
              cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number;
            }
          | undefined;
        if (usage) {
          accumulatedUsage.inputTokens += usage.input_tokens || 0;
          accumulatedUsage.outputTokens += usage.output_tokens || 0;
          accumulatedUsage.cacheReadTokens += usage.cache_read_input_tokens || 0;
          accumulatedUsage.cacheWriteTokens +=
            usage.cache_creation_input_tokens || 0;
        }
        if (typeof msg.total_cost_usd === 'number') {
          accumulatedUsage.costUsd = msg.total_cost_usd;
        }
        if (typeof msg.duration_ms === 'number') {
          accumulatedUsage.durationMs = msg.duration_ms;
        }
        if (typeof msg.duration_api_ms === 'number') {
          accumulatedUsage.durationApiMs = msg.duration_api_ms;
        }
        if (typeof msg.num_turns === 'number') {
          accumulatedUsage.numTurns = msg.num_turns;
        }

        // If the SDK result is null but the agent emitted text blocks during
        // the turn (mixed with tool_use), use the accumulated texts as the
        // effective result. This prevents the null-result retry from firing
        // when the agent already wrote a full response. (#30)
        const effectiveResult = textResult
          || (assistantTexts.length > 0 ? assistantTexts.join('\n\n') : null);

        if (!effectiveResult && nullResultRetries < 1) {
          nullResultRetries++;
          stream.push(
            '[system] You completed tool calls but did not send a visible reply. Please respond to the user.',
          );
          continue;
        }

        yield {
          type: 'result',
          status: 'success',
          result: effectiveResult || null,
          newSessionId,
          resumeAt: lastAssistantUuid,
          usage: accumulatedUsage,
          textsAlreadyStreamed: assistantTexts.length,
        };
        if (textResult) {
          nullResultRetries = 0;
        }
        ipcPolling = false;
        stream.end();
      }
    }

    ipcPolling = false;

    if (resultCount === 0 && assistantTexts.length > 0) {
      yield {
        type: 'result',
        status: 'success',
        result: null,
        newSessionId,
        resumeAt: lastAssistantUuid,
        usage: accumulatedUsage,
        textsAlreadyStreamed: assistantTexts.length,
      };
    }

    if (closedDuringQuery) {
      yield {
        type: 'result',
        status: 'success',
        result: null,
        newSessionId,
        resumeAt: lastAssistantUuid,
      };
    }
  }
}
