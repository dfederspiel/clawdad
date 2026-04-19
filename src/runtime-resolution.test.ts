import { describe, expect, it } from 'vitest';

import {
  envRuntimeFallback,
  mergeRuntimeConfigs,
  resolveTurnConstraints,
} from './runtime-resolution.js';
import type { Agent, RegisteredGroup } from './types.js';

function makeGroup(
  containerConfig?: RegisteredGroup['containerConfig'],
): RegisteredGroup {
  return {
    name: 'Test',
    folder: 'test',
    trigger: '@test',
    added_at: '2026-04-17T00:00:00.000Z',
    containerConfig,
  };
}

function makeAgent(
  trigger: string | undefined,
  containerConfig?: Agent['containerConfig'],
  runtime?: Agent['runtime'],
  tools?: Agent['tools'],
): Agent {
  return {
    id: 'test/agent',
    groupFolder: 'test',
    name: 'agent',
    displayName: 'Agent',
    trigger,
    containerConfig,
    runtime,
    tools,
  };
}

describe('runtime-resolution', () => {
  it('merges runtime configs with later entries taking precedence', () => {
    const resolved = mergeRuntimeConfigs(
      { provider: 'anthropic', model: 'claude-sonnet-4' },
      { model: 'claude-opus-4-1' },
      { temperature: 0.2 },
    );

    expect(resolved).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-1',
      baseUrl: undefined,
      temperature: 0.2,
      maxTokens: undefined,
    });
  });

  it('defaults to anthropic when only a model is provided', () => {
    const resolved = mergeRuntimeConfigs({ model: 'claude-sonnet-4' });
    expect(resolved.provider).toBe('anthropic');
    expect(resolved.model).toBe('claude-sonnet-4');
  });

  it('derives a global anthropic fallback from CLAUDE_MODEL', () => {
    expect(
      envRuntimeFallback({
        CLAUDE_MODEL: 'claude-opus-4-1',
      } as NodeJS.ProcessEnv),
    ).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-1',
    });
  });
});

describe('resolveTurnConstraints', () => {
  it('returns undefined when no config and no specialist trigger', () => {
    expect(resolveTurnConstraints(undefined, makeGroup())).toBeUndefined();
    expect(
      resolveTurnConstraints(makeAgent(undefined), makeGroup()),
    ).toBeUndefined();
  });

  it('auto-blocks delegate_to_agent for specialists', () => {
    const result = resolveTurnConstraints(makeAgent('@analyst'), makeGroup());
    expect(result).toEqual({
      disallowedTools: ['mcp__nanoclaw__delegate_to_agent'],
    });
  });

  it('does not auto-block for coordinators (no trigger)', () => {
    expect(
      resolveTurnConstraints(makeAgent(undefined), makeGroup()),
    ).toBeUndefined();
  });

  it('lets agent maxTurns override group maxTurns', () => {
    const result = resolveTurnConstraints(
      makeAgent(undefined, { maxTurns: 5 }),
      makeGroup({ maxTurns: 20 }),
    );
    expect(result).toEqual({ maxTurns: 5 });
  });

  it('falls back to group maxTurns when agent has none', () => {
    const result = resolveTurnConstraints(
      makeAgent(undefined),
      makeGroup({ maxTurns: 12 }),
    );
    expect(result).toEqual({ maxTurns: 12 });
  });

  it('unions disallowedTools from group and agent', () => {
    const result = resolveTurnConstraints(
      makeAgent(undefined, { disallowedTools: ['WebSearch'] }),
      makeGroup({ disallowedTools: ['Bash'] }),
    );
    expect(result?.disallowedTools?.sort()).toEqual(['Bash', 'WebSearch']);
  });

  it('dedupes overlapping disallowedTools', () => {
    const result = resolveTurnConstraints(
      makeAgent(undefined, { disallowedTools: ['WebSearch', 'Bash'] }),
      makeGroup({ disallowedTools: ['Bash'] }),
    );
    expect(result?.disallowedTools?.sort()).toEqual(['Bash', 'WebSearch']);
  });

  it('combines specialist auto-block with configured disallowedTools', () => {
    const result = resolveTurnConstraints(
      makeAgent('@scout', { disallowedTools: ['WebSearch'] }),
      makeGroup(),
    );
    expect(result?.disallowedTools?.sort()).toEqual([
      'WebSearch',
      'mcp__nanoclaw__delegate_to_agent',
    ]);
  });

  it('merges maxTurns and disallowedTools together', () => {
    const result = resolveTurnConstraints(
      makeAgent('@scout', { maxTurns: 10, disallowedTools: ['WebSearch'] }),
      makeGroup({ maxTurns: 50 }),
    );
    expect(result?.maxTurns).toBe(10);
    expect(result?.disallowedTools?.sort()).toEqual([
      'WebSearch',
      'mcp__nanoclaw__delegate_to_agent',
    ]);
  });

  // --- Role-scoped allowedTools (#74 Phase 1) ---

  it('narrows Ollama tool-capable specialists to a minimal tool set', () => {
    const result = resolveTurnConstraints(
      makeAgent('@scout', undefined, {
        provider: 'ollama',
        model: 'qwen3.5:4b',
      }),
      makeGroup(),
    );
    expect(result?.allowedTools?.sort()).toEqual([
      'mcp__nanoclaw__send_message',
      'mcp__nanoclaw__set_agent_status',
    ]);
  });

  it('does not narrow Ollama tool-less specialists (no tools anyway)', () => {
    const result = resolveTurnConstraints(
      makeAgent('@scout', undefined, {
        provider: 'ollama',
        model: 'llama3.2:1b',
      }),
      makeGroup(),
    );
    expect(result?.allowedTools).toBeUndefined();
  });

  it('does not narrow Claude specialists (SDK handles wide tool sets)', () => {
    const result = resolveTurnConstraints(
      makeAgent('@scout', undefined, { provider: 'anthropic' }),
      makeGroup(),
    );
    expect(result?.allowedTools).toBeUndefined();
  });

  it('does not narrow Ollama coordinators — they need delegation tools', () => {
    const result = resolveTurnConstraints(
      makeAgent(undefined, undefined, {
        provider: 'ollama',
        model: 'qwen3.5:4b',
      }),
      makeGroup(),
    );
    expect(result?.allowedTools).toBeUndefined();
  });

  // --- Per-agent tools override (#74 Phase 2) ---

  it('honours an explicit agent.tools override on a Claude specialist', () => {
    const result = resolveTurnConstraints(
      makeAgent('@researcher', undefined, { provider: 'anthropic' }, [
        'WebSearch',
        'WebFetch',
        'mcp__nanoclaw__send_message',
      ]),
      makeGroup(),
    );
    expect(result?.allowedTools).toEqual([
      'WebSearch',
      'WebFetch',
      'mcp__nanoclaw__send_message',
    ]);
  });

  it('honours an explicit agent.tools override on a coordinator', () => {
    const result = resolveTurnConstraints(
      makeAgent(undefined, undefined, { provider: 'anthropic' }, ['WebSearch']),
      makeGroup(),
    );
    expect(result?.allowedTools).toEqual(['WebSearch']);
  });

  it('explicit agent.tools overrides the Ollama role default (widens it)', () => {
    const result = resolveTurnConstraints(
      makeAgent(
        '@scout',
        undefined,
        { provider: 'ollama', model: 'qwen3.5:4b' },
        ['mcp__nanoclaw__send_message', 'WebSearch'],
      ),
      makeGroup(),
    );
    expect(result?.allowedTools).toEqual([
      'mcp__nanoclaw__send_message',
      'WebSearch',
    ]);
  });

  it('honours an empty agent.tools array as an explicit "no tools" opt-out', () => {
    const result = resolveTurnConstraints(
      makeAgent('@quiet', undefined, { provider: 'anthropic' }, []),
      makeGroup(),
    );
    expect(result?.allowedTools).toEqual([]);
  });
});
