import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadAgentFromDir } from './agent-discovery.js';

describe('loadAgentFromDir — agent.json parsing', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-discovery-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeAgentJson(config: Record<string, unknown>): string {
    const agentDir = path.join(tmpRoot, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'CLAUDE.md'), '# test\n');
    fs.writeFileSync(path.join(agentDir, 'agent.json'), JSON.stringify(config));
    return agentDir;
  }

  it('defaults skills and tools to undefined when agent.json omits them', () => {
    const agentDir = writeAgentJson({
      displayName: 'Stub',
      trigger: '@stub',
    });
    const agent = loadAgentFromDir('web_test', 'stub', agentDir);
    expect(agent.tools).toBeUndefined();
    expect(agent.skills).toBeUndefined();
  });

  it('loads skills as a string array when provided', () => {
    const agentDir = writeAgentJson({
      skills: ['rich-output', 'status'],
    });
    const agent = loadAgentFromDir('web_test', 'stub', agentDir);
    expect(agent.skills).toEqual(['rich-output', 'status']);
  });

  it('preserves an empty skills array ("no skills" opt-out)', () => {
    const agentDir = writeAgentJson({ skills: [] });
    const agent = loadAgentFromDir('web_test', 'stub', agentDir);
    expect(agent.skills).toEqual([]);
  });

  it('drops non-string entries in the skills array', () => {
    const agentDir = writeAgentJson({
      skills: ['rich-output', 42, null, 'status'],
    });
    const agent = loadAgentFromDir('web_test', 'stub', agentDir);
    expect(agent.skills).toEqual(['rich-output', 'status']);
  });

  it('ignores skills when the value is not an array', () => {
    const agentDir = writeAgentJson({
      skills: 'rich-output',
    });
    const agent = loadAgentFromDir('web_test', 'stub', agentDir);
    expect(agent.skills).toBeUndefined();
  });

  it('loads tools and skills independently without cross-contamination', () => {
    const agentDir = writeAgentJson({
      tools: ['WebSearch'],
      skills: ['agent-browser'],
    });
    const agent = loadAgentFromDir('web_test', 'stub', agentDir);
    expect(agent.tools).toEqual(['WebSearch']);
    expect(agent.skills).toEqual(['agent-browser']);
  });
});
