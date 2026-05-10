import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  storeChatMetadata,
  storeMessageDirect,
} from './db.js';
import {
  _clearAchievementBroadcaster,
  _resetAchievementCacheForTests,
  checkPlatformAchievements,
  setAchievementBroadcaster,
  unlockAchievement,
} from './achievements.js';

// All tests share an in-memory DB + a temp achievements file path.
// Achievements module hard-codes GROUPS_DIR/global/achievements.json — we
// can't redirect that without env hacks, so tests assert behavior on the
// shared file (acceptable: it's CI-scoped scratch).
describe('checkPlatformAchievements', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetAchievementCacheForTests();
    _clearAchievementBroadcaster();
    // Satisfy messages.chat_jid FK
    storeChatMetadata(
      'web:test',
      new Date().toISOString(),
      'Test',
      'web',
      true,
    );
  });

  afterEach(() => {
    _clearAchievementBroadcaster();
  });

  it('fires first_contact on the first user message', () => {
    storeMessageDirect({
      id: 'm1',
      chat_jid: 'web:test',
      timestamp: new Date().toISOString(),
      sender: 'user',
      sender_name: 'User',
      content: 'hello',
      is_from_me: false,
      is_bot_message: false,
    });
    const fired = checkPlatformAchievements();
    const ids = fired.map((d) => d.id);
    expect(ids).toContain('first_contact');
  });

  it('fires clockwork on the first scheduled task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'web_x',
      chat_jid: 'web:x',
      prompt: 'hi',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2026-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const fired = checkPlatformAchievements();
    expect(fired.map((d) => d.id)).toContain('clockwork');
  });

  it('fires assembly_line only when one group has ≥3 tasks', () => {
    for (let i = 0; i < 2; i++) {
      createTask({
        id: `t-${i}`,
        group_folder: 'web_a',
        chat_jid: 'web:a',
        prompt: 'p',
        schedule_type: 'once',
        schedule_value: '2026-01-01T00:00:00.000Z',
        context_mode: 'isolated',
        next_run: '2026-01-01T00:00:00.000Z',
        status: 'active',
        created_at: '2026-01-01T00:00:00.000Z',
      });
    }
    let fired = checkPlatformAchievements();
    expect(fired.map((d) => d.id)).not.toContain('assembly_line');

    createTask({
      id: 't-2',
      group_folder: 'web_a',
      chat_jid: 'web:a',
      prompt: 'p',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2026-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    fired = checkPlatformAchievements();
    expect(fired.map((d) => d.id)).toContain('assembly_line');
  });

  it('fires architect only when registeredGroupCount ≥ 3', () => {
    let fired = checkPlatformAchievements({ registeredGroupCount: 2 });
    expect(fired.map((d) => d.id)).not.toContain('architect');
    fired = checkPlatformAchievements({ registeredGroupCount: 3 });
    expect(fired.map((d) => d.id)).toContain('architect');
  });

  it('does not re-fire an already-unlocked achievement', () => {
    storeMessageDirect({
      id: 'm1',
      chat_jid: 'web:test',
      timestamp: new Date().toISOString(),
      sender: 'user',
      sender_name: 'User',
      content: 'hello',
      is_from_me: false,
      is_bot_message: false,
    });
    const first = checkPlatformAchievements();
    expect(first.map((d) => d.id)).toContain('first_contact');
    const second = checkPlatformAchievements();
    expect(second.map((d) => d.id)).not.toContain('first_contact');
  });

  it('fires the broadcaster for each new unlock', () => {
    const broadcaster = vi.fn();
    setAchievementBroadcaster(broadcaster);
    storeMessageDirect({
      id: 'm1',
      chat_jid: 'web:test',
      timestamp: new Date().toISOString(),
      sender: 'user',
      sender_name: 'User',
      content: 'hello',
      is_from_me: false,
      is_bot_message: false,
    });
    checkPlatformAchievements();
    expect(broadcaster).toHaveBeenCalled();
    const firedIds = broadcaster.mock.calls.map((c) => c[0].id);
    expect(firedIds).toContain('first_contact');
  });
});

describe('unlockAchievement broadcaster integration', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetAchievementCacheForTests();
    _clearAchievementBroadcaster();
  });

  it('emits via the registered broadcaster', () => {
    const broadcaster = vi.fn();
    setAchievementBroadcaster(broadcaster);
    const def = unlockAchievement('cross_talk', 'web_x');
    expect(def?.id).toBe('cross_talk');
    expect(broadcaster).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cross_talk' }),
      'web_x',
    );
  });

  it('does not throw when no broadcaster is set', () => {
    _clearAchievementBroadcaster();
    expect(() => unlockAchievement('cross_talk', 'web_x')).not.toThrow();
  });

  it('returns null on a duplicate unlock and does not re-emit', () => {
    const broadcaster = vi.fn();
    setAchievementBroadcaster(broadcaster);
    unlockAchievement('cross_talk', 'web_x');
    broadcaster.mockClear();
    const second = unlockAchievement('cross_talk', 'web_x');
    expect(second).toBeNull();
    expect(broadcaster).not.toHaveBeenCalled();
  });
});
