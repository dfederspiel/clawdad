import { describe, it, expect } from 'vitest';

import { getTriggeredAgentsForMessages } from './agent-routing.js';
import type { Agent, NewMessage } from './types.js';

describe('getTriggeredAgentsForMessages', () => {
  const agents: Agent[] = [
    {
      id: 'team/coordinator',
      groupFolder: 'team',
      name: 'coordinator',
      displayName: 'Coordinator',
    },
    {
      id: 'team/analyst',
      groupFolder: 'team',
      name: 'analyst',
      displayName: 'Analyst',
      trigger: '@analyst',
    },
    {
      id: 'team/reviewer',
      groupFolder: 'team',
      name: 'reviewer',
      displayName: 'Reviewer',
      trigger: '@reviewer',
    },
  ];

  const makeMessage = (overrides: Partial<NewMessage>): NewMessage => ({
    id: overrides.id || 'm1',
    chat_jid: overrides.chat_jid || 'group@g.us',
    sender: overrides.sender || 'user',
    sender_name: overrides.sender_name || 'User',
    content: overrides.content || '',
    timestamp: overrides.timestamp || '2026-04-07T00:00:00.000Z',
    is_from_me: overrides.is_from_me,
    is_bot_message: overrides.is_bot_message,
    thread_id: overrides.thread_id,
    usage: overrides.usage,
  });

  it('does not let agent-authored messages trigger specialists', () => {
    const triggered = getTriggeredAgentsForMessages(agents, [
      makeMessage({
        sender_name: 'Coordinator',
        is_bot_message: true,
        content: 'I am asking @analyst to take a look.',
      }),
    ]);

    expect(triggered.map((a) => a.name)).toEqual(['coordinator']);
  });

  it('still lets user-authored messages trigger specialists', () => {
    const triggered = getTriggeredAgentsForMessages(agents, [
      makeMessage({
        sender_name: 'User',
        content: 'Can @analyst and @reviewer check this?',
      }),
    ]);

    expect(triggered.map((a) => a.name)).toEqual([
      'coordinator',
      'analyst',
      'reviewer',
    ]);
  });

  it('does not let a mixed batch trigger specialists from bot-authored text alone', () => {
    const triggered = getTriggeredAgentsForMessages(agents, [
      makeMessage({
        id: 'bot-1',
        sender_name: 'Coordinator',
        is_bot_message: true,
        content: '@analyst please take a look.',
      }),
      makeMessage({
        id: 'user-1',
        sender_name: 'User',
        content: 'hello',
      }),
    ]);

    expect(triggered.map((a) => a.name)).toEqual(['coordinator']);
  });

  it('can force coordinator-only routing for delegation retriggers', () => {
    const triggered = getTriggeredAgentsForMessages(
      agents,
      [
        makeMessage({
          sender_name: 'User',
          content: 'Can @analyst and @reviewer check this?',
        }),
      ],
      { coordinatorOnly: true },
    );

    expect(triggered.map((a) => a.name)).toEqual(['coordinator']);
  });
});
