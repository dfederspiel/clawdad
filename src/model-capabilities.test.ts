import { describe, expect, it } from 'vitest';

import { getCapabilityProfile } from './model-capabilities.js';
import { buildMultiAgentContext } from './agent-discovery.js';
import type { Agent } from './types.js';

describe('getCapabilityProfile', () => {
  it('returns the anthropic profile when runtime is undefined (platform default)', () => {
    const p = getCapabilityProfile(undefined);
    expect(p.receivesMcpTools).toBe(true);
    expect(p.streaming).toBe('chunked');
  });

  it('returns the anthropic profile for explicit anthropic', () => {
    const p = getCapabilityProfile({ provider: 'anthropic' });
    expect(p.receivesMcpTools).toBe(true);
  });

  it('reports ollama as tool-less — the adapter does not pass tools today', () => {
    const p = getCapabilityProfile({ provider: 'ollama', model: 'qwen3.5:4b' });
    expect(p.receivesMcpTools).toBe(false);
    expect(p.streaming).toBe('per-token');
  });

  it('falls back to a tool-less profile for not-yet-wired providers', () => {
    const p = getCapabilityProfile({ provider: 'openai' });
    expect(p.receivesMcpTools).toBe(false);
  });
});

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: 'web_team/x',
    groupFolder: 'web_team',
    name: 'x',
    displayName: 'X',
    ...overrides,
  };
}

describe('buildMultiAgentContext', () => {
  const coord = agent({
    id: 'web_team/coord',
    name: 'coord',
    displayName: 'Coord',
  });
  const spec = agent({
    id: 'web_team/spec',
    name: 'spec',
    displayName: 'Spec',
    trigger: '@spec',
  });

  it('returns empty when the group has a single agent', () => {
    expect(buildMultiAgentContext(coord, [coord])).toBe('');
  });

  it('tool-capable coordinator gets the full MCP delegation protocol', () => {
    const out = buildMultiAgentContext(coord, [coord, spec]);
    expect(out).toContain('mcp__nanoclaw__delegate_to_agent');
    expect(out).toContain('mcp__nanoclaw__set_subtitle');
  });

  it('tool-less coordinator gets a text-only protocol with no MCP references', () => {
    const ollamaCoord = agent({
      ...coord,
      runtime: { provider: 'ollama', model: 'qwen3.5:4b' },
    });
    const out = buildMultiAgentContext(ollamaCoord, [ollamaCoord, spec]);
    expect(out).not.toContain('mcp__nanoclaw__');
    expect(out).toContain('does not have tool-calling access');
    expect(out).toContain('cannot delegate');
  });

  it('tool-capable specialist gets MCP status + protocol references', () => {
    const out = buildMultiAgentContext(spec, [coord, spec]);
    expect(out).toContain('mcp__nanoclaw__set_agent_status');
  });

  it('tool-less specialist description is plain-text-only', () => {
    const ollamaSpec = agent({
      ...spec,
      runtime: { provider: 'ollama', model: 'llama3.2:1b' },
    });
    const out = buildMultiAgentContext(ollamaSpec, [coord, ollamaSpec]);
    expect(out).not.toContain('mcp__nanoclaw__');
    expect(out).toContain('plain text');
    expect(out).toContain('delivered to the user');
  });

  it('lists teammates regardless of capability profile', () => {
    const ollamaSpec = agent({
      ...spec,
      runtime: { provider: 'ollama' },
    });
    const out = buildMultiAgentContext(ollamaSpec, [coord, ollamaSpec]);
    expect(out).toContain('Coord');
  });
});
