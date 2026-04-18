/**
 * Ollama runtime adapter — runs agents entirely on local Ollama models.
 *
 * Phase 1: Text-only, streaming, no tool use, no session resume.
 * Built on the official `ollama` client (see ./ollama-client.ts for the
 * host-fallback fetch wrapper).
 */

import fs from 'fs';
import type { Message } from 'ollama';

import { getOllamaClient } from './ollama-client.js';
import type {
  RuntimeEvent,
  RuntimeTurnInput,
  RuntimeUsageData,
} from './runtime-interface.js';

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
  isMain: boolean;
  systemContext?: string;
  assistantName?: string;
}

export class OllamaRuntime {
  constructor(
    private readonly options: {
      containerInput: ContainerInputLike;
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

    // Build Ollama message array.
    const messages: Message[] = [];

    // System prompt for Ollama: only load agent-specific identity and
    // multi-agent context. Skip global and group CLAUDE.md — those contain
    // Claude-specific infrastructure (MCP tools, credential proxy, api.sh)
    // that confuses non-Claude models.
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
        for (const xm of xmlMessages) {
          messages.push(xm);
        }
      } else if (fullText.trim()) {
        messages.push({ role: msg.role, content: fullText });
      }
    }

    const temperature = input.runtime.temperature;
    const maxTokens = input.runtime.maxTokens;

    const options: Record<string, unknown> = {};
    if (temperature !== undefined) options.temperature = temperature;
    if (maxTokens !== undefined) options.num_predict = maxTokens;

    log(`Ollama: calling ${model} with ${messages.length} messages`);

    const client = getOllamaClient();
    let stream;
    try {
      stream = await client.chat({
        model,
        messages,
        stream: true,
        options: Object.keys(options).length > 0 ? options : undefined,
      });
    } catch (err) {
      yield {
        type: 'result',
        status: 'error',
        result: null,
        error: `Failed to connect to Ollama: ${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }

    let fullText = '';
    let firstTokenTime: number | undefined;
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
          if (!firstTokenTime) firstTokenTime = Date.now();
          // Buffer tokens into fullText and let the final `result` yield
          // deliver the whole message at once. Yielding per-token text
          // events produces one chat message per token downstream — the
          // intermediate-text pathway was designed for Claude's paragraph-
          // sized chunks, not per-token streams.
          fullText += chunk.message.content;
        }
        if (chunk.done) {
          finalChunk = chunk;
        }
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

    const durationMs = Date.now() - startTime;
    const usage: RuntimeUsageData = {
      inputTokens: finalChunk?.prompt_eval_count || 0,
      outputTokens: finalChunk?.eval_count || 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0, // local models are free
      durationMs,
      durationApiMs: finalChunk?.total_duration
        ? finalChunk.total_duration / 1e6
        : durationMs,
      numTurns: 1,
    };

    log(
      `Ollama: ${model} done — ${usage.outputTokens} tokens, ${(durationMs / 1000).toFixed(1)}s`,
    );

    yield {
      type: 'result',
      status: 'success',
      result: fullText || null,
      usage,
      textsAlreadyStreamed: fullText ? 1 : 0,
      // Ollama is stateless — no session resume
      newSessionId: undefined,
      resumeAt: undefined,
    };
  }
}
