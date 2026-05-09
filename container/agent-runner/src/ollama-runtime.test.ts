import { describe, it, expect } from 'vitest';

import {
  USER_VISIBLE_TOOL_NAMES,
  isUserVisibleTool,
  parseTextModeToolCall,
} from './ollama-runtime.js';

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
