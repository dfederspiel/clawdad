import { describe, expect, it } from 'vitest';

import { formatDelegationResults } from './coordinator-context.js';
import type { DelegationRun } from './types.js';

const baseRun: DelegationRun = {
  id: 'del-1',
  groupJid: 'group@g.us',
  groupFolder: 'team-folder',
  coordinatorAgentId: 'team-folder/coordinator',
  targetAgentId: 'team-folder/scout',
  message: 'Inspect this',
  status: 'completed',
  visibility: 'portal',
  completionPolicy: 'retrigger_coordinator',
  batchId: 'batch-1',
  createdAt: '2026-05-04T00:00:00.000Z',
};

describe('formatDelegationResults', () => {
  it('formats completed delegation runs for coordinator context', () => {
    expect(
      formatDelegationResults([
        {
          ...baseRun,
          result: 'The service is healthy.',
        },
      ]),
    ).toBe(
      [
        '--- Delegation Results ---',
        'Run: del-1',
        'Agent: scout',
        'Status: completed',
        'Result:',
        'The service is healthy.',
        '--- End Delegation Results ---',
      ].join('\n'),
    );
  });

  it('returns an empty string for no runs', () => {
    expect(formatDelegationResults([])).toBe('');
  });
});
