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

// Allowlist of Ollama models for which we pass MCP tools. Starts narrow:
// qwen3.5:4b is our baseline that we've verified in development. Wider
// support comes as we confirm each model's reliability. Too-small models
// (llama3.2:1b, llama3.2:3b) stay off this list even though Ollama's
// /api/show reports tools: true — they produce narration of tool calls
// rather than real invocations.
const TOOL_CAPABLE_OLLAMA_MODELS = new Set<string>([
  'qwen3.5:4b',
]);

export function ollamaModelSupportsTools(model: string): boolean {
  return TOOL_CAPABLE_OLLAMA_MODELS.has(model);
}

const MAX_TOOL_TURNS = 10;

/**
 * Parse the XML-formatted conversation history produced by the host's
 * formatMessages() into individual Ollama chat messages. Bot messages
 * become assistant role, everything else becomes user role.
 *
 * Tracked for removal in #46 — host should pass structured messages so
 * this reverse-engineering step goes away.
 */
function parseXmlMessages(text: string, assistantName?: string): Message[] {
  const msgRegex =
    /<message\s+sender="([^"]*)"\s+time="[^"]*">([^<]*(?:<(?!\/message>)[^<]*)*)<\/message>/g;
  const results: Message[] = [];
  let match;
  while ((match = msgRegex.exec(text)) !== null) {
    const sender = match[1];
    const content = match[2]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .trim();
    if (!content) continue;
    const isBot =
      (assistantName && sender === assistantName) ||
      /^(Andy|Assistant|Bot)$/i.test(sender);
    results.push({
      role: isBot ? 'assistant' : 'user',
      content,
    });
  }
  return results;
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
      ollamaModelSupportsTools(model) && Boolean(this.options.mcpServerPath);
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
   * Build the system prompt + user/assistant history, parsing XML as
   * needed. Shared between text-only and tool-capable paths.
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

    for (const msg of input.messages) {
      const textParts = msg.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text);
      const fullText = textParts.join('\n');
      const xmlMessages = parseXmlMessages(
        fullText,
        this.options.containerInput.assistantName,
      );
      if (xmlMessages.length > 0) {
        for (const xm of xmlMessages) messages.push(xm);
      } else if (fullText.trim()) {
        messages.push({ role: msg.role, content: fullText });
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
    let finalChunk:
      | {
          total_duration?: number;
          eval_count?: number;
          prompt_eval_count?: number;
        }
      | undefined;

    try {
      for await (const chunk of stream) {
        if (chunk.message?.content) fullText += chunk.message.content;
        if (chunk.done) finalChunk = chunk;
      }
    } catch (err) {
      yield {
        type: 'result',
        status: 'error',
        result: null,
        error: `Ollama stream error: ${err instanceof Error ? err.message : String(err)}`,
      };
      return;
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
      toolsForOllama = bridge.toProviderSpecs(toolDescriptors).map(specToOllamaTool);
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
      `Ollama: calling ${model} with ${seedMessages.length} messages, ${toolsForOllama.length} tools (tool-capable)`,
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
          for (const call of toolCalls) {
            const name = call.function.name;
            const args = call.function.arguments ?? {};
            log(`Ollama tool_call: ${name}`);
            const result = await bridge.executeToolCall(name, args);
            messages.push({
              role: 'tool',
              content: result.content,
              tool_name: name,
            });
            if (!result.isError) deliveredViaTools = true;
          }
          continue;
        }

        // No tool calls → the model produced a final response.
        if (response.message?.content) fullText = response.message.content;
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
