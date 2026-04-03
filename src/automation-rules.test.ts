import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AutomationEvent,
  AutomationRule,
  emitTraces,
  evaluateRules,
  loadGroupAutomationRules,
  resetChainDepth,
  resetCooldowns,
} from './automation-rules.js';

// Mock fs and group-folder so we don't touch disk
vi.mock('fs');
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) => `/mock/groups/${folder}`,
}));

const mockFs = vi.mocked(fs);

// Reset safety control state before each test
beforeEach(() => {
  resetChainDepth('web_test-team');
  resetCooldowns();
});

function makeRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'test-rule',
    enabled: true,
    when: { event: 'message' },
    then: [{ type: 'delegate_to_agent', agent: 'reviewer', silent: true }],
    ...overrides,
  };
}

function makeEvent(overrides: Partial<AutomationEvent> = {}): AutomationEvent {
  return {
    type: 'message',
    groupJid: 'web:test',
    groupFolder: 'web_test-team',
    messageContent: 'hello @review this PR',
    senderType: 'user',
    ...overrides,
  };
}

describe('loadGroupAutomationRules', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('loads valid rules from group-config.json', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        automation: [
          {
            id: 'r1',
            enabled: true,
            when: { event: 'message', pattern: '@review' },
            then: [{ type: 'delegate_to_agent', agent: 'reviewer' }],
          },
        ],
      }),
    );
    const rules = loadGroupAutomationRules('web_test-team');
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('r1');
  });

  it('returns empty array when file does not exist', () => {
    mockFs.existsSync.mockReturnValue(false);
    expect(loadGroupAutomationRules('web_test-team')).toEqual([]);
  });

  it('returns empty array when automation key is missing', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({ triggerScope: 'own' }),
    );
    expect(loadGroupAutomationRules('web_test-team')).toEqual([]);
  });

  it('filters out disabled rules', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        automation: [
          {
            id: 'r1',
            enabled: false,
            when: { event: 'message' },
            then: [{ type: 'delegate_to_agent', agent: 'a' }],
          },
          {
            id: 'r2',
            enabled: true,
            when: { event: 'message' },
            then: [{ type: 'delegate_to_agent', agent: 'b' }],
          },
        ],
      }),
    );
    const rules = loadGroupAutomationRules('web_test-team');
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('r2');
  });

  it('skips malformed rules (missing id or when)', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        automation: [
          { when: { event: 'message' }, then: [] }, // no id
          { id: 'r2', then: [] }, // no when
          { id: 'r3', when: {}, then: [] }, // no event in when
          {
            id: 'r4',
            enabled: true,
            when: { event: 'message' },
            then: [{ type: 'delegate_to_agent', agent: 'a' }],
          },
        ],
      }),
    );
    const rules = loadGroupAutomationRules('web_test-team');
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('r4');
  });

  it('returns empty on parse error', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('not json');
    expect(loadGroupAutomationRules('web_test-team')).toEqual([]);
  });
});

describe('evaluateRules — message events', () => {
  it('matches bare message event (no pattern/sender filter)', () => {
    const traces = evaluateRules([makeRule()], makeEvent());
    expect(traces).toHaveLength(1);
    expect(traces[0].ruleId).toBe('test-rule');
    expect(traces[0].outcome).toBe('would_fire');
  });

  it('matches when pattern is present in content', () => {
    const rule = makeRule({
      when: { event: 'message', pattern: '@review' },
    });
    const traces = evaluateRules([rule], makeEvent());
    expect(traces).toHaveLength(1);
  });

  it('does not match when pattern is absent from content', () => {
    const rule = makeRule({
      when: { event: 'message', pattern: '@deploy' },
    });
    const traces = evaluateRules(
      [rule],
      makeEvent({ messageContent: 'just a chat message' }),
    );
    expect(traces).toHaveLength(0);
  });

  it('matches when sender type matches', () => {
    const rule = makeRule({
      when: { event: 'message', sender: 'user' },
    });
    const traces = evaluateRules([rule], makeEvent({ senderType: 'user' }));
    expect(traces).toHaveLength(1);
  });

  it('does not match when sender type differs', () => {
    const rule = makeRule({
      when: { event: 'message', sender: 'assistant' },
    });
    const traces = evaluateRules([rule], makeEvent({ senderType: 'user' }));
    expect(traces).toHaveLength(0);
  });

  it('matches when both pattern and sender match', () => {
    const rule = makeRule({
      when: { event: 'message', pattern: '@review', sender: 'user' },
    });
    const traces = evaluateRules([rule], makeEvent());
    expect(traces).toHaveLength(1);
  });

  it('supports regex patterns', () => {
    const rule = makeRule({
      when: { event: 'message', pattern: '@(review|check)' },
    });
    const traces = evaluateRules(
      [rule],
      makeEvent({ messageContent: 'please @check this' }),
    );
    expect(traces).toHaveLength(1);
  });

  it('skips rule with invalid regex (does not crash)', () => {
    const rule = makeRule({
      when: { event: 'message', pattern: '(unclosed' },
    });
    const traces = evaluateRules([rule], makeEvent());
    expect(traces).toHaveLength(0);
  });
});

describe('evaluateRules — agent_result events', () => {
  it('matches when agent name matches', () => {
    const rule = makeRule({
      when: { event: 'agent_result', agent: 'researcher' },
      then: [{ type: 'delegate_to_agent', agent: 'summarizer', silent: true }],
    });
    const traces = evaluateRules(
      [rule],
      makeEvent({
        type: 'agent_result',
        agentName: 'researcher',
        resultContent: 'findings...',
      }),
    );
    expect(traces).toHaveLength(1);
  });

  it('does not match different agent name', () => {
    const rule = makeRule({
      when: { event: 'agent_result', agent: 'researcher' },
    });
    const traces = evaluateRules(
      [rule],
      makeEvent({ type: 'agent_result', agentName: 'writer' }),
    );
    expect(traces).toHaveLength(0);
  });

  it('matches when contains substring is found', () => {
    const rule = makeRule({
      when: { event: 'agent_result', contains: 'URGENT' },
    });
    const traces = evaluateRules(
      [rule],
      makeEvent({
        type: 'agent_result',
        agentName: 'monitor',
        resultContent: 'Alert: URGENT issue detected',
      }),
    );
    expect(traces).toHaveLength(1);
  });

  it('does not match missing substring', () => {
    const rule = makeRule({
      when: { event: 'agent_result', contains: 'URGENT' },
    });
    const traces = evaluateRules(
      [rule],
      makeEvent({
        type: 'agent_result',
        agentName: 'monitor',
        resultContent: 'All clear',
      }),
    );
    expect(traces).toHaveLength(0);
  });
});

describe('evaluateRules — task_completed events', () => {
  it('matches when taskId matches', () => {
    const rule = makeRule({
      when: { event: 'task_completed', taskId: 'weekly-report' },
    });
    const traces = evaluateRules(
      [rule],
      makeEvent({ type: 'task_completed', taskId: 'weekly-report' }),
    );
    expect(traces).toHaveLength(1);
  });

  it('does not match different taskId', () => {
    const rule = makeRule({
      when: { event: 'task_completed', taskId: 'weekly-report' },
    });
    const traces = evaluateRules(
      [rule],
      makeEvent({ type: 'task_completed', taskId: 'daily-standup' }),
    );
    expect(traces).toHaveLength(0);
  });

  it('matches bare task_completed (no taskId filter)', () => {
    const rule = makeRule({
      when: { event: 'task_completed' },
    });
    const traces = evaluateRules(
      [rule],
      makeEvent({ type: 'task_completed', taskId: 'anything' }),
    );
    expect(traces).toHaveLength(1);
  });
});

describe('evaluateRules — cross-event isolation', () => {
  it('message rule does not fire on agent_result event', () => {
    const rule = makeRule({ when: { event: 'message' } });
    const traces = evaluateRules(
      [rule],
      makeEvent({ type: 'agent_result', agentName: 'researcher' }),
    );
    expect(traces).toHaveLength(0);
  });

  it('multiple rules can match the same event', () => {
    const rules = [
      makeRule({ id: 'r1', when: { event: 'message', pattern: '@review' } }),
      makeRule({ id: 'r2', when: { event: 'message', sender: 'user' } }),
    ];
    const traces = evaluateRules(rules, makeEvent());
    expect(traces).toHaveLength(2);
    expect(traces.map((t) => t.ruleId)).toEqual(['r1', 'r2']);
  });

  it('empty rules array produces no traces', () => {
    expect(evaluateRules([], makeEvent())).toEqual([]);
  });
});

describe('trace structure', () => {
  it('includes all required fields', () => {
    const rule = makeRule({
      then: [
        { type: 'delegate_to_agent', agent: 'reviewer', silent: true },
        { type: 'fan_out', agents: ['a', 'b'], silent: false },
      ],
    });
    const [trace] = evaluateRules([rule], makeEvent());
    expect(trace.timestamp).toBeTruthy();
    expect(trace.groupJid).toBe('web:test');
    expect(trace.groupFolder).toBe('web_test-team');
    expect(trace.sourceEvent).toBe('message');
    expect(trace.ruleId).toBe('test-rule');
    expect(trace.outcome).toBe('would_fire');
    expect(trace.eventSummary).toBe('message from user');
    expect(trace.actions).toEqual([
      { type: 'delegate_to_agent', targetAgent: 'reviewer', silent: true },
      { type: 'fan_out', targetAgent: 'a, b', silent: false },
    ]);
  });
});

describe('safety controls', () => {
  beforeEach(() => {
    resetChainDepth('web_test-team');
  });

  it('enforces chain depth limit', () => {
    const event = makeEvent({ type: 'agent_result', agentName: 'a' });

    // Use unique rule IDs to avoid cooldown interference
    const rule1 = makeRule({ id: 'chain-1', when: { event: 'agent_result' } });
    const rule2 = makeRule({ id: 'chain-2', when: { event: 'agent_result' } });
    const rule3 = makeRule({ id: 'chain-3', when: { event: 'agent_result' } });
    const rule4 = makeRule({ id: 'chain-4', when: { event: 'agent_result' } });

    // First 3 evaluations should work (depth 1, 2, 3)
    expect(evaluateRules([rule1], event)).toHaveLength(1);
    expect(evaluateRules([rule2], event)).toHaveLength(1);
    expect(evaluateRules([rule3], event)).toHaveLength(1);

    // 4th should be suppressed (depth > 3)
    expect(evaluateRules([rule4], event)).toHaveLength(0);
  });

  it('resets chain depth on message events via evaluateAutomationRules', () => {
    const event = makeEvent({ type: 'agent_result', agentName: 'a' });

    // Exhaust chain depth with unique rule IDs
    evaluateRules(
      [makeRule({ id: 'r-1', when: { event: 'agent_result' } })],
      event,
    );
    evaluateRules(
      [makeRule({ id: 'r-2', when: { event: 'agent_result' } })],
      event,
    );
    evaluateRules(
      [makeRule({ id: 'r-3', when: { event: 'agent_result' } })],
      event,
    );
    expect(
      evaluateRules(
        [makeRule({ id: 'r-4', when: { event: 'agent_result' } })],
        event,
      ),
    ).toHaveLength(0);

    // Reset and verify
    resetChainDepth('web_test-team');
    resetCooldowns();
    expect(
      evaluateRules(
        [makeRule({ id: 'r-5', when: { event: 'agent_result' } })],
        event,
      ),
    ).toHaveLength(1);
  });

  it('enforces per-rule cooldown', () => {
    const rule = makeRule({ id: 'cooldown-test' });
    const event = makeEvent();

    resetChainDepth('web_test-team');
    // First fire should work
    expect(evaluateRules([rule], event)).toHaveLength(1);

    resetChainDepth('web_test-team');
    // Second fire within cooldown should be skipped
    expect(evaluateRules([rule], event)).toHaveLength(0);
  });

  it('validates target agents at load time', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        automation: [
          {
            id: 'valid',
            enabled: true,
            when: { event: 'message' },
            then: [{ type: 'delegate_to_agent', agent: 'analyst' }],
          },
          {
            id: 'invalid-target',
            enabled: true,
            when: { event: 'message' },
            then: [{ type: 'delegate_to_agent', agent: 'nonexistent' }],
          },
        ],
      }),
    );
    const rules = loadGroupAutomationRules('web_test-team', [
      'analyst',
      'writer',
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('valid');
  });

  it('validates fan_out target agents', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        automation: [
          {
            id: 'bad-fanout',
            enabled: true,
            when: { event: 'message' },
            then: [{ type: 'fan_out', agents: ['analyst', 'ghost'] }],
          },
        ],
      }),
    );
    const rules = loadGroupAutomationRules('web_test-team', [
      'analyst',
      'writer',
    ]);
    expect(rules).toHaveLength(0);
  });

  it('skips target validation when knownAgents not provided', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        automation: [
          {
            id: 'any-target',
            enabled: true,
            when: { event: 'message' },
            then: [{ type: 'delegate_to_agent', agent: 'whatever' }],
          },
        ],
      }),
    );
    const rules = loadGroupAutomationRules('web_test-team');
    expect(rules).toHaveLength(1);
  });
});

describe('emitTraces', () => {
  it('does not throw on empty array', () => {
    expect(() => emitTraces([])).not.toThrow();
  });

  it('does not throw with valid traces', () => {
    const [trace] = evaluateRules([makeRule()], makeEvent());
    expect(() => emitTraces([trace])).not.toThrow();
  });
});
