import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  isValidGroupFolder,
  resolveAgentIpcInputPath,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from './group-folder.js';

describe('group folder validation', () => {
  it('accepts normal group folder names', () => {
    expect(isValidGroupFolder('main')).toBe(true);
    expect(isValidGroupFolder('family-chat')).toBe(true);
    expect(isValidGroupFolder('Team_42')).toBe(true);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidGroupFolder('../../etc')).toBe(false);
    expect(isValidGroupFolder('/tmp')).toBe(false);
    expect(isValidGroupFolder('global')).toBe(false);
    expect(isValidGroupFolder('')).toBe(false);
  });

  it('resolves safe paths under groups directory', () => {
    const resolved = resolveGroupFolderPath('family-chat');
    expect(resolved.endsWith(`${path.sep}groups${path.sep}family-chat`)).toBe(
      true,
    );
  });

  it('resolves safe paths under data ipc directory', () => {
    const resolved = resolveGroupIpcPath('family-chat');
    expect(
      resolved.endsWith(`${path.sep}data${path.sep}ipc${path.sep}family-chat`),
    ).toBe(true);
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveGroupFolderPath('../../etc')).toThrow();
    expect(() => resolveGroupIpcPath('/tmp')).toThrow();
  });

  describe('resolveAgentIpcInputPath', () => {
    it('resolves valid agent input paths', () => {
      const resolved = resolveAgentIpcInputPath('family-chat', 'analyst');
      expect(resolved).toMatch(
        /data[/\\]ipc[/\\]family-chat[/\\]analyst[/\\]input$/,
      );
    });

    it('accepts agent names with hyphens and underscores', () => {
      const resolved = resolveAgentIpcInputPath('team', 'code-reviewer');
      expect(resolved).toMatch(/code-reviewer[/\\]input$/);
      const resolved2 = resolveAgentIpcInputPath('team', 'my_agent');
      expect(resolved2).toMatch(/my_agent[/\\]input$/);
    });

    it('rejects empty agent name', () => {
      expect(() => resolveAgentIpcInputPath('team', '')).toThrow(
        'agentName is required',
      );
    });

    it('rejects agent names with path traversal', () => {
      expect(() => resolveAgentIpcInputPath('team', '../etc')).toThrow(
        'Unsafe agent name',
      );
      expect(() => resolveAgentIpcInputPath('team', '../../root')).toThrow(
        'Unsafe agent name',
      );
    });

    it('rejects agent names with slashes', () => {
      expect(() => resolveAgentIpcInputPath('team', 'foo/bar')).toThrow(
        'Unsafe agent name',
      );
      expect(() => resolveAgentIpcInputPath('team', 'foo\\bar')).toThrow(
        'Unsafe agent name',
      );
    });

    it('rejects agent names with special characters', () => {
      expect(() => resolveAgentIpcInputPath('team', 'agent name')).toThrow(
        'Unsafe agent name',
      );
      expect(() => resolveAgentIpcInputPath('team', 'agent@home')).toThrow(
        'Unsafe agent name',
      );
      expect(() => resolveAgentIpcInputPath('team', 'agent;rm')).toThrow(
        'Unsafe agent name',
      );
    });

    it('rejects invalid group folder', () => {
      expect(() => resolveAgentIpcInputPath('../../etc', 'analyst')).toThrow();
    });
  });
});
