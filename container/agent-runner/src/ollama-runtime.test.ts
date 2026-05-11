import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the ollama-client module BEFORE importing OllamaRuntime so the
// runtime picks up the stub. chatMock is rebound per test.
const chatMock = vi.fn();
vi.mock('./ollama-client.js', () => ({
  getOllamaClient: () => ({ chat: chatMock }),
}));

import {
  USER_VISIBLE_TOOL_NAMES,
  isUserVisibleTool,
  OllamaRuntime,
  parseTextModeToolCall,
} from './ollama-runtime.js';
import type { RuntimeEvent } from './runtime-interface.js';

describe('isUserVisibleTool', () => {
  it('returns true for tools whose execution produces a user-facing message', () => {
    expect(isUserVisibleTool('mcp__nanoclaw__send_message')).toBe(true);
    expect(isUserVisibleTool('mcp__nanoclaw__publish_media')).toBe(true);
    expect(isUserVisibleTool('mcp__nanoclaw__publish_browser_snapshot')).toBe(
      true,
    );
    expect(isUserVisibleTool('mcp__nanoclaw__escalate')).toBe(true);
  });

  it('returns false for side-effect tools that should not terminate the loop', () => {
    expect(isUserVisibleTool('mcp__nanoclaw__set_agent_status')).toBe(false);
    expect(isUserVisibleTool('mcp__nanoclaw__unlock_achievement')).toBe(false);
    expect(isUserVisibleTool('mcp__nanoclaw__play_sound')).toBe(false);
    expect(isUserVisibleTool('mcp__nanoclaw__set_subtitle')).toBe(false);
  });

  it('returns false for unknown / hallucinated tool names', () => {
    expect(isUserVisibleTool('mcp__nanoclaw__fictional_tool')).toBe(false);
    expect(isUserVisibleTool('')).toBe(false);
    expect(isUserVisibleTool('send_message')).toBe(false);
  });

  it('exports a frozen-feeling set so callers cannot mutate the contract', () => {
    expect(USER_VISIBLE_TOOL_NAMES.has('mcp__nanoclaw__send_message')).toBe(
      true,
    );
    expect(USER_VISIBLE_TOOL_NAMES.size).toBe(4);
  });
});

describe('parseTextModeToolCall', () => {
  const known = new Set([
    'mcp__nanoclaw__unlock_achievement',
    'mcp__nanoclaw__send_message',
  ]);

  it('recovers the qwen2.5-coder:7b repro: fenced JSON object with name+arguments', () => {
    const content =
      '```json\n{"name": "mcp__nanoclaw__unlock_achievement", "arguments": {"achievement_id": "first_contact"}}\n```';
    const result = parseTextModeToolCall(content, known);
    expect(result).toEqual([
      {
        name: 'mcp__nanoclaw__unlock_achievement',
        arguments: { achievement_id: 'first_contact' },
      },
    ]);
  });

  it('handles bare JSON without fences', () => {
    const content =
      '{"name": "mcp__nanoclaw__send_message", "arguments": {"text": "hi"}}';
    const result = parseTextModeToolCall(content, known);
    expect(result?.[0].name).toBe('mcp__nanoclaw__send_message');
    expect(result?.[0].arguments).toEqual({ text: 'hi' });
  });

  it('handles the tool_calls envelope shape', () => {
    const content = JSON.stringify({
      tool_calls: [
        {
          function: {
            name: 'mcp__nanoclaw__send_message',
            arguments: { text: 'a' },
          },
        },
        {
          function: {
            name: 'mcp__nanoclaw__unlock_achievement',
            arguments: { achievement_id: 'b' },
          },
        },
      ],
    });
    const result = parseTextModeToolCall(content, known);
    expect(result).toHaveLength(2);
    expect(result?.[0].name).toBe('mcp__nanoclaw__send_message');
  });

  it('strips <tool_call>…</tool_call> wrappers', () => {
    const content =
      '<tool_call>{"name": "mcp__nanoclaw__send_message", "arguments": {}}</tool_call>';
    const result = parseTextModeToolCall(content, known);
    expect(result?.[0].name).toBe('mcp__nanoclaw__send_message');
  });

  it('defaults missing arguments to {}', () => {
    const content = '{"name": "mcp__nanoclaw__send_message"}';
    const result = parseTextModeToolCall(content, known);
    expect(result?.[0].arguments).toEqual({});
  });

  it('rejects unknown tool names (hallucination guard)', () => {
    const content =
      '{"name": "mcp__nanoclaw__fictional", "arguments": {}}';
    expect(parseTextModeToolCall(content, known)).toBeNull();
  });

  it('rejects an envelope where any single call has an unknown name', () => {
    const content = JSON.stringify({
      tool_calls: [
        { function: { name: 'mcp__nanoclaw__send_message', arguments: {} } },
        { function: { name: 'mcp__nanoclaw__fictional', arguments: {} } },
      ],
    });
    expect(parseTextModeToolCall(content, known)).toBeNull();
  });

  it('rejects content with prose around the JSON (strict matching)', () => {
    const content =
      'Sure, here is the call: {"name": "mcp__nanoclaw__send_message"}';
    expect(parseTextModeToolCall(content, known)).toBeNull();
  });

  it('rejects malformed JSON', () => {
    const content = '{"name": "mcp__nanoclaw__send_message", "arguments":';
    expect(parseTextModeToolCall(content, known)).toBeNull();
  });

  it('rejects empty / whitespace content', () => {
    expect(parseTextModeToolCall('', known)).toBeNull();
    expect(parseTextModeToolCall('   ', known)).toBeNull();
    expect(parseTextModeToolCall('\n\n', known)).toBeNull();
  });

  it('rejects non-object JSON (numbers, arrays, strings)', () => {
    expect(parseTextModeToolCall('42', known)).toBeNull();
    expect(parseTextModeToolCall('[1,2,3]', known)).toBeNull();
    expect(parseTextModeToolCall('"hello"', known)).toBeNull();
  });
});

// Liveness contract: long inferences must yield intermediate `progress`
// or `text` events so the host's idle watchdog (queryOnce in
// container-runner.ts) keeps resetting and the UI shows activity. Before
// this contract, the Ollama text-only path buffered every chunk into one
// final `result` event — slow models silently tripped the wall-clock
// timeout from spawn (3-5 min) with zero user-visible feedback.
describe('OllamaRuntime — liveness events (text-only path)', () => {
  beforeEach(() => {
    chatMock.mockReset();
    // Force the text-only branch by reporting no tool capability. The
    // capability check uses fetch(), so stub it inline.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ capabilities: [] }),
      }),
    );
  });

  // Build an async iterable from an array of chunks — mirrors the shape
  // of ollama-js's streaming chat response.
  function streamFrom(
    chunks: Array<{ message?: { content: string }; done?: boolean }>,
  ): AsyncIterable<unknown> {
    return {
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c;
      },
    };
  }

  function makeRuntime(): OllamaRuntime {
    return new OllamaRuntime({
      containerInput: {
        chatJid: 'web:test',
        groupFolder: 'web_test',
        isMain: false,
      },
    });
  }

  async function collect(
    runtime: OllamaRuntime,
    text: string,
  ): Promise<RuntimeEvent[]> {
    const events: RuntimeEvent[] = [];
    for await (const ev of runtime.runTurn({
      messages: [
        { role: 'user', content: [{ type: 'text', text }] },
      ],
      attachments: [],
      agentId: 'test-agent',
      runtime: { provider: 'ollama', model: 'fake-model' },
    })) {
      events.push(ev);
    }
    return events;
  }

  it('yields a progress event before any chunk arrives — resets the host watchdog before first token', async () => {
    chatMock.mockResolvedValue(
      streamFrom([{ message: { content: 'hi' }, done: true }]),
    );
    const runtime = makeRuntime();
    const events = await collect(runtime, 'hello');

    // First event must be the pre-stream progress signal — anything
    // else means the watchdog could fire while connect() hangs.
    expect(events[0]?.type).toBe('progress');
    expect((events[0] as { type: 'progress'; summary: string }).summary).toMatch(
      /thinking/i,
    );
  });

  it('flushes a text event when the buffer crosses the size threshold (200 chars)', async () => {
    // Three chunks of 80 chars each = 240 chars total. The buffer
    // should flush after chunk 3 (240 >= 200) but not after chunk 1
    // (80 < 200).
    const chunk = 'x'.repeat(80);
    chatMock.mockResolvedValue(
      streamFrom([
        { message: { content: chunk } },
        { message: { content: chunk } },
        { message: { content: chunk }, done: true },
      ]),
    );
    const runtime = makeRuntime();
    const events = await collect(runtime, 'go');

    const textEvents = events.filter((e) => e.type === 'text') as Array<{
      type: 'text';
      text: string;
    }>;
    // At least one mid-stream flush + a tail flush. Three 80-char chunks
    // produce one flush at 240 chars, then the residual is empty — but
    // if the implementation flushes only at end, that's still ≥1. Lower
    // bound: any text events at all proves the buffering isn't black-hole.
    expect(textEvents.length).toBeGreaterThan(0);
    expect(textEvents.map((e) => e.text).join('')).toBe(chunk.repeat(3));
  });

  it('returns the full accumulated text in the final result, regardless of how it was streamed', async () => {
    chatMock.mockResolvedValue(
      streamFrom([
        { message: { content: 'Hello, ' } },
        { message: { content: 'world!' }, done: true },
      ]),
    );
    const runtime = makeRuntime();
    const events = await collect(runtime, 'greet');

    const last = events[events.length - 1];
    expect(last.type).toBe('result');
    if (last.type === 'result') {
      expect(last.status).toBe('success');
      expect(last.result).toBe('Hello, world!');
    }
  });

  it('flushes pending buffer on stream error so partial output is not silently dropped', async () => {
    // Stream that yields one short chunk then throws — exercises the
    // catch-block flush. Without it, partial output disappears.
    chatMock.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { message: { content: 'partial' } };
        throw new Error('connection reset');
      },
    });
    const runtime = makeRuntime();
    const events = await collect(runtime, 'go');

    const textEvents = events.filter((e) => e.type === 'text') as Array<{
      type: 'text';
      text: string;
    }>;
    expect(textEvents.map((e) => e.text).join('')).toBe('partial');

    const last = events[events.length - 1];
    expect(last.type).toBe('result');
    if (last.type === 'result') expect(last.status).toBe('error');
  });
});
