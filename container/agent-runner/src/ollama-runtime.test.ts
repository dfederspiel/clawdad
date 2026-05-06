import { describe, it, expect } from 'vitest';

import {
  USER_VISIBLE_TOOL_NAMES,
  isUserVisibleTool,
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
