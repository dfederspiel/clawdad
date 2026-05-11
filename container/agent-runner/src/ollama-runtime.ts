/**
 * Ollama runtime adapter — runs agents entirely on local Ollama models.
 *
 * Two execution paths:
 *
 *   1. Text-only (default): single non-streaming-friendly request, whole
 *      reply is delivered as the user-visible message via the host's
 *      text fallback. Used for small models (llama3.2:1b, etc.) that
 *      can't reliably call tools.
 *
 *   2. Tool-capable: spawns the nanoclaw MCP server through ToolBridge,
 *      lists tools, passes them to Ollama's /api/chat, and runs an
 *      agentic loop — detect tool_calls → execute via bridge → feed
 *      back as role:tool messages → loop until the model produces
 *      plain content or a maxTurns cap is hit. Used for qwen3.5:4b
 *      today (see ollamaModelSupportsTools for the allowlist).
 */

import fs from 'fs';
import type { Message, Tool, ToolCall } from 'ollama';

import { getOllamaClient } from './ollama-client.js';
import type {
  RuntimeEvent,
  RuntimeTurnInput,
  RuntimeUsageData,
} from './runtime-interface.js';
import {
  ToolBridge,
  type McpToolDescriptor,
  type ProviderToolSpec,
} from './tool-bridge.js';

// Per-model capability cache derived from Ollama's /api/show. Empirical
// probe (scripts/probe-ollama-tools.ts on host) showed the previous
// hardcoded allowlist was wrong — both llama3.2:1b and qwen3.5:4b emit
// structured tool_calls; the small model just has weaker argument
// adherence, which is a reliability concern not a capability gap. We
// now trust the self-report and rely on observability to surface bad
// outcomes per model.
const toolCapabilityCache = new Map<string, boolean>();

async function fetchSupportsTools(model: string): Promise<boolean> {
  const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
  try {
    const res = await fetch(`${host}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { capabilities?: string[] };
    return (body.capabilities ?? []).includes('tools');
  } catch {
    return false;
  }
}

export async function ollamaModelSupportsTools(model: string): Promise<boolean> {
  const cached = toolCapabilityCache.get(model);
  if (cached !== undefined) return cached;
  const supports = await fetchSupportsTools(model);
  toolCapabilityCache.set(model, supports);
  return supports;
}

const MAX_TOOL_TURNS = 10;

// Streaming-text liveness cadence. Each yielded `text` event resets the
// host's idle watchdog and updates the typing indicator. Smaller values
// = more responsive UI but noisier event stream; we batch by char count
// OR elapsed time, whichever fires first.
const TEXT_CHUNK_FLUSH_CHARS = 200;
const TEXT_CHUNK_FLUSH_INTERVAL_MS = 1500;

/** Compact human-readable summary of a tool invocation for progress display. */
function summarizeOllamaToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
): string {
  if (!args) return name;
  // Strip MCP qualified-name prefix (mcp__server__tool → tool) for display.
  const display = name.replace(/^mcp__[^_]+__/, '');
  // Pick one short value to surface; prefer common identifying fields.
  const candidate =
    (args.message as string | undefined) ||
    (args.text as string | undefined) ||
    (args.summary as string | undefined) ||
    (args.title as string | undefined) ||
    (args.path as string | undefined) ||
    (args.file_path as string | undefined) ||
    (args.url as string | undefined) ||
    (args.query as string | undefined);
  if (typeof candidate === 'string' && candidate.length > 0) {
    const trimmed = candidate.split('\n')[0].slice(0, 60);
    return `${display}: ${trimmed}`;
  }
  return display;
}

/**
 * Tools whose execution itself produces a user-visible message in the chat.
 * After the model invokes one, we exit the tool loop without giving it
 * another turn — Ollama models trained on tool-use are prone to emit a
 * conversational summary after a tool ("Hello!" after a `send_message`
 * that already greeted the user), which lands as a duplicate bubble.
 *
 * See #75 for the full analysis. Side-effect tools (set_agent_status,
 * unlock_achievement, play_sound, etc.) are intentionally absent — they
 * don't produce visible content, so the model should still get a turn
 * to author the actual reply afterwards.
 */
export const USER_VISIBLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'mcp__nanoclaw__send_message',
  'mcp__nanoclaw__publish_media',
  'mcp__nanoclaw__publish_browser_snapshot',
  'mcp__nanoclaw__escalate',
]);

export function isUserVisibleTool(qualifiedName: string): boolean {
  return USER_VISIBLE_TOOL_NAMES.has(qualifiedName);
}

interface ContainerInputLike {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  agentName?: string;
  agentId?: string;
  runBatchId?: string;
  canDelegate?: boolean;
  mainChatJid?: string;
  systemContext?: string;
  assistantName?: string;
  achievements?: unknown[];
  portalThreadId?: string;
}

/**
 * Env vars the nanoclaw MCP server expects — mirrors what claude-runtime
 * passes so the same MCP server works for either adapter.
 */
function mcpServerEnv(
  containerInput: ContainerInputLike,
  sessionId: string | undefined,
): Record<string, string> {
  return {
    NANOCLAW_CHAT_JID: containerInput.chatJid,
    NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
    NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    NANOCLAW_AGENT_NAME: containerInput.agentName || 'default',
    NANOCLAW_AGENT_ID: containerInput.agentId || '',
    NANOCLAW_RUN_BATCH_ID: containerInput.runBatchId || '',
    NANOCLAW_SESSION_ID: sessionId || '',
    NANOCLAW_CAN_DELEGATE: containerInput.canDelegate ? '1' : '0',
    NANOCLAW_MAIN_JID: containerInput.mainChatJid || '',
    NANOCLAW_ACHIEVEMENTS: JSON.stringify(containerInput.achievements || []),
    // When set, IPC-driven tools (e.g. send_message) tag outputs so the
    // host can route them to the side-panel portal instead of main feed.
    NANOCLAW_PORTAL_THREAD_ID: containerInput.portalThreadId || '',
  };
}

function specToOllamaTool(spec: ProviderToolSpec): Tool {
  return {
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters as Tool['function']['parameters'],
    },
  };
}

/**
 * Recover a tool call that the model emitted as JSON in `message.content`
 * instead of populating the structured `tool_calls` channel. Smaller
 * tool-capable models (qwen2.5-coder:7b, etc.) hit this often enough that
 * silently delivering the JSON to the user is a meaningful regression.
 *
 * Strict by construction:
 *  1. Content must be exactly a JSON object (after fence/wrapper stripping)
 *     — prose around the JSON disqualifies it. Better to miss a recovery
 *     than to invoke a tool the model was just discussing.
 *  2. The `name` must be in the live tool-list passed to the model. A
 *     hallucinated tool name is treated as text.
 *  3. `arguments` must be an object (or absent — defaults to `{}`).
 */
export function parseTextModeToolCall(
  content: string,
  knownToolNames: Set<string>,
): Array<{ name: string; arguments: Record<string, unknown> }> | null {
  if (!content) return null;

  let cleaned = content.trim();
  // Some models wrap the call in <tool_call>…</tool_call>.
  cleaned = cleaned.replace(/^<tool_call>\s*|\s*<\/tool_call>$/g, '').trim();
  // Markdown fences with or without a language hint.
  cleaned = cleaned
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

  if (!cleaned.startsWith('{') || !cleaned.endsWith('}')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  // Envelope: { tool_calls: [{ function: { name, arguments } }, ...] }
  if (Array.isArray(obj.tool_calls)) {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> =
      [];
    for (const c of obj.tool_calls) {
      if (typeof c !== 'object' || c === null) return null;
      const fn = (c as { function?: unknown }).function;
      if (typeof fn !== 'object' || fn === null) return null;
      const fnObj = fn as { name?: unknown; arguments?: unknown };
      if (typeof fnObj.name !== 'string' || !knownToolNames.has(fnObj.name))
        return null;
      const args = fnObj.arguments;
      calls.push({
        name: fnObj.name,
        arguments:
          typeof args === 'object' && args !== null
            ? (args as Record<string, unknown>)
            : {},
      });
    }
    return calls.length > 0 ? calls : null;
  }

  // Single-call: { name, arguments? }
  if (typeof obj.name !== 'string' || !knownToolNames.has(obj.name))
    return null;
  const args = obj.arguments;
  return [
    {
      name: obj.name,
      arguments:
        typeof args === 'object' && args !== null
          ? (args as Record<string, unknown>)
          : {},
    },
  ];
}

export class OllamaRuntime {
  constructor(
    private readonly options: {
      containerInput: ContainerInputLike;
      /**
       * Path to the nanoclaw MCP stdio server. Required for tool-capable
       * Ollama models; if absent or the model isn't in the allowlist we
       * fall back to the text-only path.
       */
      mcpServerPath?: string;
      /** Session id propagated to the MCP server env. */
      sessionId?: string;
      log?: (message: string) => void;
    },
  ) {}

  async *runTurn(input: RuntimeTurnInput): AsyncIterable<RuntimeEvent> {
    const model = input.runtime.model;
    if (!model) {
      yield {
        type: 'result',
        status: 'error',
        result: null,
        error:
          'Ollama runtime requires a model to be specified in agent.json (e.g. "llama3.2")',
      };
      return;
    }

    const log = this.options.log || (() => {});
    const startTime = Date.now();

    const baseMessages = await this.buildBaseMessages(input);
    const temperature = input.runtime.temperature;
    const maxTokens = input.runtime.maxTokens;
    const options: Record<string, unknown> = {};
    if (temperature !== undefined) options.temperature = temperature;
    if (maxTokens !== undefined) options.num_predict = maxTokens;
    const chatOptions = Object.keys(options).length > 0 ? options : undefined;

    const toolsEnabled =
      Boolean(this.options.mcpServerPath) &&
      (await ollamaModelSupportsTools(model));
    if (toolsEnabled) {
      yield* this.runToolLoop(
        model,
        baseMessages,
        chatOptions,
        input,
        startTime,
        log,
      );
    } else {
      yield* this.runTextOnly(
        model,
        baseMessages,
        chatOptions,
        startTime,
        log,
      );
    }
  }

  /**
   * Build the system prompt + user/assistant history from the structured
   * messages the host passes in ContainerInput (see #46). Shared between
   * text-only and tool-capable paths.
   */
  private async buildBaseMessages(
    input: RuntimeTurnInput,
  ): Promise<Message[]> {
    const messages: Message[] = [];

    // System prompt: agent identity + platform-injected multi-agent
    // context. Skip global and group CLAUDE.md — those carry Claude-
    // specific infrastructure references that confuse non-Claude models.
    const systemParts: string[] = [];
    const agentClaudeMdPath = '/workspace/agent/CLAUDE.md';
    if (fs.existsSync(agentClaudeMdPath)) {
      systemParts.push(fs.readFileSync(agentClaudeMdPath, 'utf-8'));
    }
    if (this.options.containerInput.systemContext) {
      systemParts.push(this.options.containerInput.systemContext);
    }
    if (systemParts.length > 0) {
      messages.push({ role: 'system', content: systemParts.join('\n\n') });
    }

    // Structured path (#46): the host now populates containerInput.messages
    // and the container-runner hands them to us as pre-structured
    // RuntimeMessages. Pass role + joined text through verbatim — no more
    // reverse-engineering XML to guess who said what.
    for (const msg of input.messages) {
      const text = msg.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
        .trim();
      if (text) {
        messages.push({ role: msg.role, content: text });
      }
    }

    return messages;
  }

  // -- Text-only path ---------------------------------------------------

  private async *runTextOnly(
    model: string,
    messages: Message[],
    options: Record<string, unknown> | undefined,
    startTime: number,
    log: (m: string) => void,
  ): AsyncIterable<RuntimeEvent> {
    const client = getOllamaClient();

    // Liveness event before the stream starts — resets the host's idle
    // watchdog immediately so a slow first-token doesn't trip the timeout
    // before any chunk arrives.
    yield {
      type: 'progress',
      summary: `Thinking (${model})...`,
      timestamp: new Date().toISOString(),
    };

    let stream;
    try {
      stream = await client.chat({ model, messages, stream: true, options });
    } catch (err) {
      yield {
        type: 'result',
        status: 'error',
        result: null,
        error: `Failed to connect to Ollama: ${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }

    log(`Ollama: calling ${model} with ${messages.length} messages (text-only)`);

    let fullText = '';
    let pendingChunk = '';
    let lastFlush = Date.now();
    let finalChunk:
      | {
          total_duration?: number;
          eval_count?: number;
          prompt_eval_count?: number;
        }
      | undefined;

    try {
      for await (const chunk of stream) {
        if (chunk.message?.content) {
          fullText += chunk.message.content;
          pendingChunk += chunk.message.content;
          const now = Date.now();
          if (
            pendingChunk.length >= TEXT_CHUNK_FLUSH_CHARS ||
            now - lastFlush >= TEXT_CHUNK_FLUSH_INTERVAL_MS
          ) {
            yield {
              type: 'text',
              text: pendingChunk,
              timestamp: new Date().toISOString(),
            };
            pendingChunk = '';
            lastFlush = now;
          }
        }
        if (chunk.done) finalChunk = chunk;
      }
    } catch (err) {
      // Flush whatever we have — gives the host one last liveness signal
      // and surfaces partial output in logs/debug instead of vanishing.
      if (pendingChunk) {
        yield {
          type: 'text',
          text: pendingChunk,
          timestamp: new Date().toISOString(),
        };
      }
      yield {
        type: 'result',
        status: 'error',
        result: null,
        error: `Ollama stream error: ${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }

    if (pendingChunk) {
      yield {
        type: 'text',
        text: pendingChunk,
        timestamp: new Date().toISOString(),
      };
    }

    yield buildResultEvent({
      model,
      startTime,
      log,
      fullText,
      finalChunk,
      numTurns: 1,
      deliveredViaTools: false,
    });
  }

  // -- Tool-capable path -----------------------------------------------

  private async *runToolLoop(
    model: string,
    seedMessages: Message[],
    options: Record<string, unknown> | undefined,
    input: RuntimeTurnInput,
    startTime: number,
    log: (m: string) => void,
  ): AsyncIterable<RuntimeEvent> {
    const mcpServerPath = this.options.mcpServerPath!;
    const client = getOllamaClient();
    const bridge = new ToolBridge({
      servers: [
        {
          name: 'nanoclaw',
          command: 'node',
          args: [mcpServerPath],
          env: mcpServerEnv(this.options.containerInput, this.options.sessionId),
        },
      ],
    });

    let toolsForOllama: Tool[];
    let toolDescriptors: McpToolDescriptor[];
    try {
      await bridge.connect();
      toolDescriptors = await bridge.listTools(input.constraints?.disallowedTools);
      // When the host passed an allowedTools list (role-scoped narrowing —
      // see runtime-resolution.resolveTurnConstraints), filter to only
      // those. Small tool-capable models hallucinate when given many
      // simultaneous tools; narrow scopes stop that.
      const allowSet = input.constraints?.allowedTools
        ? new Set(input.constraints.allowedTools)
        : null;
      const narrowed = allowSet
        ? toolDescriptors.filter((d) => allowSet.has(d.qualifiedName))
        : toolDescriptors;
      toolsForOllama = bridge.toProviderSpecs(narrowed).map(specToOllamaTool);
    } catch (err) {
      await bridge.close();
      yield {
        type: 'result',
        status: 'error',
        result: null,
        error: `Failed to initialise ToolBridge for ${model}: ${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }

    log(
      `Ollama: calling ${model} with ${seedMessages.length} messages, ${toolsForOllama.length} tools (tool-capable${
        input.constraints?.allowedTools ? ', narrowed' : ''
      })`,
    );

    const messages: Message[] = [...seedMessages];
    let fullText = '';
    let deliveredViaTools = false;
    let finalChunk:
      | {
          total_duration?: number;
          eval_count?: number;
          prompt_eval_count?: number;
        }
      | undefined;
    let turns = 0;

    try {
      for (turns = 0; turns < MAX_TOOL_TURNS; turns++) {
        // Liveness signal before each (potentially long) inference call.
        // Resets the host's idle watchdog and tells the UI which turn the
        // model is on so a multi-turn tool loop doesn't look frozen.
        yield {
          type: 'progress',
          summary:
            turns === 0
              ? `Thinking (${model})...`
              : `Thinking (${model}, turn ${turns + 1}/${MAX_TOOL_TURNS})...`,
          timestamp: new Date().toISOString(),
        };

        // Tool loop doesn't stream — the response object exposes
        // tool_calls directly and we need the full message before we can
        // decide whether to keep looping.
        const response = await client.chat({
          model,
          messages,
          stream: false,
          options,
          tools: toolsForOllama,
        });
        finalChunk = response;

        const toolCalls = response.message?.tool_calls as
          | ToolCall[]
          | undefined;
        if (toolCalls && toolCalls.length > 0) {
          // Append the assistant's tool-call message verbatim so the model
          // can reason about its own prior call on the next turn.
          messages.push({
            role: 'assistant',
            content: response.message.content ?? '',
            tool_calls: toolCalls,
          });
          let userVisibleDelivered = false;
          for (const call of toolCalls) {
            const name = call.function.name;
            const args = call.function.arguments ?? {};
            log(`Ollama tool_call: ${name}`);
            yield {
              type: 'progress',
              tool: name,
              summary: summarizeOllamaToolCall(name, args),
              timestamp: new Date().toISOString(),
            };
            const result = await bridge.executeToolCall(name, args);
            messages.push({
              role: 'tool',
              content: result.content,
              tool_name: name,
            });
            if (!result.isError) {
              deliveredViaTools = true;
              if (isUserVisibleTool(name)) userVisibleDelivered = true;
            }
          }
          // If any successful tool call already delivered user-visible
          // content, end the turn — see USER_VISIBLE_TOOL_NAMES (#75).
          if (userVisibleDelivered) {
            log(
              `Ollama: ${model} delivered user-visible content via tool; ending turn`,
            );
            break;
          }
          continue;
        }

        // Recovery: marginal tool-capable models occasionally emit the call
        // as JSON in message.content instead of populating tool_calls. Strict
        // parser — content must be exactly a tool-call envelope and the name
        // must match a real tool — to avoid invoking on prose that just
        // discusses JSON. See parseTextModeToolCall.
        const knownToolNames = new Set(
          toolsForOllama
            .map((t) => t.function.name)
            .filter((n): n is string => typeof n === 'string'),
        );
        const recovered = parseTextModeToolCall(
          response.message?.content ?? '',
          knownToolNames,
        );
        if (recovered) {
          log(
            `Ollama: recovered ${recovered.length} text-mode tool call(s) from ${model}`,
          );
          messages.push({
            role: 'assistant',
            content: '',
            tool_calls: recovered.map((r) => ({
              function: { name: r.name, arguments: r.arguments },
            })) as ToolCall[],
          });
          let userVisibleDelivered = false;
          for (const call of recovered) {
            log(`Ollama tool_call (recovered): ${call.name}`);
            yield {
              type: 'progress',
              tool: call.name,
              summary: summarizeOllamaToolCall(call.name, call.arguments),
              timestamp: new Date().toISOString(),
            };
            const result = await bridge.executeToolCall(
              call.name,
              call.arguments,
            );
            messages.push({
              role: 'tool',
              content: result.content,
              tool_name: call.name,
            });
            if (!result.isError) {
              deliveredViaTools = true;
              if (isUserVisibleTool(call.name)) userVisibleDelivered = true;
            }
          }
          if (userVisibleDelivered) {
            log(
              `Ollama: ${model} delivered user-visible content via recovered tool; ending turn`,
            );
            break;
          }
          continue;
        }

        // No tool calls → the model produced a final response. Emit a
        // text event so the host's typing indicator reflects what just
        // arrived; the same content is also returned in the result event
        // for actual message delivery.
        if (response.message?.content) {
          fullText = response.message.content;
          yield {
            type: 'text',
            text: fullText,
            timestamp: new Date().toISOString(),
          };
        }
        break;
      }

      if (turns >= MAX_TOOL_TURNS) {
        log(
          `Ollama: ${model} hit max tool turns (${MAX_TOOL_TURNS}); returning last content`,
        );
      }
    } catch (err) {
      await bridge.close();
      yield {
        type: 'result',
        status: 'error',
        result: null,
        error: `Ollama tool loop error: ${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }

    await bridge.close();

    yield buildResultEvent({
      model,
      startTime,
      log,
      fullText,
      finalChunk,
      numTurns: Math.max(1, turns + 1),
      deliveredViaTools,
    });
  }
}

function buildResultEvent(params: {
  model: string;
  startTime: number;
  log: (m: string) => void;
  fullText: string;
  finalChunk?: {
    total_duration?: number;
    eval_count?: number;
    prompt_eval_count?: number;
  };
  numTurns: number;
  deliveredViaTools: boolean;
}): RuntimeEvent {
  const { model, startTime, log, fullText, finalChunk, numTurns } = params;
  const durationMs = Date.now() - startTime;
  const usage: RuntimeUsageData = {
    inputTokens: finalChunk?.prompt_eval_count || 0,
    outputTokens: finalChunk?.eval_count || 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    durationMs,
    durationApiMs: finalChunk?.total_duration
      ? finalChunk.total_duration / 1e6
      : durationMs,
    numTurns,
  };
  log(
    `Ollama: ${model} done — ${usage.outputTokens} tokens, ${(durationMs / 1000).toFixed(1)}s, ${numTurns} turn(s)`,
  );
  return {
    type: 'result',
    status: 'success',
    // If the agent only produced tool output, leave result null so the host
    // doesn't try to redeliver it as a separate chat message — the tool
    // (send_message) already did that.
    result: fullText || null,
    usage,
    textsAlreadyStreamed: params.deliveredViaTools && !fullText ? 1 : 0,
    newSessionId: undefined,
    resumeAt: undefined,
  };
}
