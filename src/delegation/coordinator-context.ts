import type { DelegationRun } from './types.js';

function agentLabel(agentId: string): string {
  return agentId.split('/').filter(Boolean).at(-1) || agentId;
}

export function formatDelegationResults(runs: DelegationRun[]): string {
  if (runs.length === 0) return '';

  const blocks = runs.map((run) => {
    const output =
      run.result?.trim() ||
      run.error?.trim() ||
      '(No result text was captured for this delegation.)';
    return [
      `Run: ${run.id}`,
      `Agent: ${agentLabel(run.targetAgentId)}`,
      `Status: ${run.status}`,
      'Result:',
      output,
    ].join('\n');
  });

  return [
    '--- Delegation Results ---',
    blocks.join('\n\n'),
    '--- End Delegation Results ---',
  ].join('\n');
}
