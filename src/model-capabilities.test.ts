import { beforeEach, describe, expect, it } from 'vitest';

import { getCapabilityProfile } from './model-capabilities.js';
import { buildMultiAgentContext } from './agent-discovery.js';
import {
  _resetOllamaCapabilitiesForTests,
  _setOllamaCapabilitiesForTests,
} from './ollama-capabilities.js';
import type { Agent } from './types.js';

beforeEach(() => {
  _resetOllamaCapabilitiesForTests();
  // Populate the capability cache as if Ollama's /api/show had reported
  // `tools` for qwen3.5:4b and omitted it for llama3.2:1b. Matches the
  // empirical probe output in scripts/probe-ollama-tools.ts.
  _setOllamaCapabilitiesForTests('qwen3.5:4b', {
    tools: true,
    vision: true,
    thinking: true,
  });
  _setOllamaCapabilitiesForTests('llama3.2:1b', {
    tools: false,
    vision: false,
    thinking: false,
  });
});

describe('getCapabilityProfile', () => {
  it('returns the anthropic profile when runtime is undefined (platform default)', () => {
    const p = getCapabilityProfile(undefined);
    expect(p.receivesMcpTools).toBe(true);
    expect(p.streaming).toBe('chunked');
    expect(p.delegationTimeoutMs).toBe(120_000);
  });

  it('returns the anthropic profile for explicit anthropic', () => {
    const p = getCapabilityProfile({ provider: 'anthropic' });
    expect(p.receivesMcpTools).toBe(true);
    expect(p.delegationTimeoutMs).toBe(120_000);
  });

  it('reports small ollama models as tool-less (not on the allowlist)', () => {
    const p = getCapabilityProfile({
      provider: 'ollama',
      model: 'llama3.2:1b',
    });
    expect(p.receivesMcpTools).toBe(false);
    expect(p.streaming).toBe('per-token');
    expect(p.delegationTimeoutMs).toBe(300_000);
  });

  it('reports ollama qwen3.5:4b as tool-capable (on the allowlist)', () => {
    const p = getCapabilityProfile({ provider: 'ollama', model: 'qwen3.5:4b' });
    expect(p.receivesMcpTools).toBe(true);
    // Tool loop runs non-streaming turns; the adapter delivers the final
    // assistant message whole.
    expect(p.streaming).toBe('whole');
    expect(p.delegationTimeoutMs).toBe(600_000);
  });

  it('treats ollama with no model as tool-less (safe default)', () => {
    const p = getCapabilityProfile({ provider: 'ollama' });
    expect(p.receivesMcpTools).toBe(false);
    expect(p.delegationTimeoutMs).toBe(300_000);
  });

  it('falls back to a tool-less profile for not-yet-wired providers', () => {
    const p = getCapabilityProfile({ provider: 'openai' });
    expect(p.receivesMcpTools).toBe(false);
    expect(p.delegationTimeoutMs).toBe(120_000);
  });

  it('gives tool-capable Ollama more delegation headroom than text-only Ollama', () => {
    const toolCapable = getCapabilityProfile({
      provider: 'ollama',
      model: 'qwen3.5:4b',
    });
    const textOnly = getCapabilityProfile({
      provider: 'ollama',
      model: 'llama3.2:1b',
    });
    expect(toolCapable.delegationTimeoutMs).toBeGreaterThan(
      textOnly.delegationTimeoutMs,
    );
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

  it('tool-less coordinator (small Ollama) gets a text-only protocol with no MCP references', () => {
    const ollamaCoord = agent({
      ...coord,
      runtime: { provider: 'ollama', model: 'llama3.2:1b' },
    });
    const out = buildMultiAgentContext(ollamaCoord, [ollamaCoord, spec]);
    expect(out).not.toContain('mcp__nanoclaw__');
    expect(out).toContain('does not have tool-calling access');
    expect(out).toContain('cannot delegate');
  });

  it('tool-capable Ollama coordinator (qwen3.5:4b) gets the MCP protocol', () => {
    const ollamaCoord = agent({
      ...coord,
      runtime: { provider: 'ollama', model: 'qwen3.5:4b' },
    });
    const out = buildMultiAgentContext(ollamaCoord, [ollamaCoord, spec]);
    expect(out).toContain('mcp__nanoclaw__delegate_to_agent');
  });

  it('tool-capable specialist gets MCP status + protocol references', () => {
    const out = buildMultiAgentContext(spec, [coord, spec]);
    expect(out).toContain('mcp__nanoclaw__set_agent_status');
  });

  it('tool-less specialist (small Ollama) description is plain-text-only', () => {
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

  it('enumerates every specialist with its own delegation example', () => {
    const analyst = agent({
      id: 'web_team/analyst',
      name: 'analyst',
      displayName: 'Analyst',
      trigger: '@analyst',
    });
    const reviewer = agent({
      id: 'web_team/reviewer',
      name: 'reviewer',
      displayName: 'Reviewer',
      trigger: '@reviewer',
    });
    const out = buildMultiAgentContext(coord, [coord, analyst, reviewer]);
    expect(out).toContain('agent: "analyst"');
    expect(out).toContain('agent: "reviewer"');
  });

  it('omits other coordinators from delegation examples (only triggered specialists)', () => {
    const secondCoord = agent({
      id: 'web_team/coord2',
      name: 'coord2',
      displayName: 'Coord2',
    });
    const out = buildMultiAgentContext(coord, [coord, secondCoord, spec]);
    // Only `spec` has a trigger; `coord2` must not appear as a delegation target.
    expect(out).toContain('agent: "spec"');
    expect(out).not.toContain('agent: "coord2"');
  });

  it('tool-capable coordinator includes a pre-response self-check against narration', () => {
    const out = buildMultiAgentContext(coord, [coord, spec]);
    expect(out).toContain('narration');
    expect(out).toMatch(/invoke.*tool/i);
  });
});
