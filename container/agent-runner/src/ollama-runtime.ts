/**
 * Ollama runtime adapter — runs agents entirely on local Ollama models.
 *
 * Phase 1: Text-only, streaming, no tool use, no session resume.
 * Uses Ollama's /api/chat endpoint with message history.
 */

import fs from 'fs';
import { ollamaFetch } from './ollama-fetch.js';
import type {
  RuntimeEvent,
  RuntimeTurnInput,
  RuntimeUsageData,
} from './runtime-interface.js';

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaStreamChunk {
  message?: { role: string; content: string };
  done: boolean;
  total_duration?: number;
  eval_count?: number;
  prompt_eval_count?: number;
  eval_duration?: number;
  prompt_eval_duration?: number;
}

/**
 * Parse the XML-formatted conversation history produced by the host's
 * formatMessages() into individual Ollama chat messages. Bot messages
 * become assistant role, everything else becomes user role.
 */
function parseXmlMessages(
  text: string,
  assistantName?: string,
): OllamaMessage[] {
  // Match <message sender="..." time="...">content</message>
  const msgRegex =
    /<message\s+sender="([^"]*)"\s+time="[^"]*">([^<]*(?:<(?!\/message>)[^<]*)*)<\/message>/g;
  const results: OllamaMessage[] = [];
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
    // Messages from the agent's own display name are assistant messages;
    // everything else is user messages.
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
        error: 'Ollama runtime requires a model to be specified in agent.json (e.g. "llama3.2")',
      };
      return;
    }

    const log = this.options.log || (() => {});
    const startTime = Date.now();

    // Build Ollama message array
    const messages: OllamaMessage[] = [];

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

    // Convert input messages — the host wraps conversation history in XML
    // (<context/><messages><message sender="..." time="...">text</message>...</messages>)
    // which confuses non-Claude models. Parse out individual messages and
    // convert to proper Ollama chat format.
    for (const msg of input.messages) {
      const textParts = msg.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text);
      const fullText = textParts.join('\n');

      // Try to parse XML-formatted conversation history
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

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
    };
    if (temperature !== undefined || maxTokens !== undefined) {
      body.options = {
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTokens !== undefined ? { num_predict: maxTokens } : {}),
      };
    }

    log(`Ollama: calling ${model} with ${messages.length} messages`);

    let response: Response;
    try {
      response = await ollamaFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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

    if (!response.ok) {
      const errorText = await response.text();
      yield {
        type: 'result',
        status: 'error',
        result: null,
        error: `Ollama error (${response.status}): ${errorText}`,
      };
      return;
    }

    // Stream NDJSON response
    const reader = response.body?.getReader();
    if (!reader) {
      yield {
        type: 'result',
        status: 'error',
        result: null,
        error: 'Ollama returned no response body',
      };
      return;
    }

    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';
    let finalChunk: OllamaStreamChunk | undefined;
    let firstTokenTime: number | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          let chunk: OllamaStreamChunk;
          try {
            chunk = JSON.parse(line);
          } catch {
            continue;
          }

          if (chunk.message?.content) {
            if (!firstTokenTime) firstTokenTime = Date.now();
            const token = chunk.message.content;
            fullText += token;
            yield {
              type: 'text',
              text: token,
              timestamp: new Date().toISOString(),
            };
          }

          if (chunk.done) {
            finalChunk = chunk;
          }
        }
      }
    } finally {
      reader.releaseLock();
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
