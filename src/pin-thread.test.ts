import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  createPinThread,
  deletePinThread,
  getPinByThreadId,
  getPinsForChat,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { renderPinnedSurfaces } from './pin-context.js';
import { NewMessage } from './types.js';

function msg(
  overrides: Partial<NewMessage> & Pick<NewMessage, 'id' | 'timestamp'>,
): NewMessage {
  return {
    chat_jid: 'web:test',
    sender: 'david@web',
    sender_name: 'David',
    content: 'hello',
    is_from_me: false,
    is_bot_message: false,
    ...overrides,
  };
}

describe('pin threads (#142)', () => {
  beforeEach(() => {
    _initTestDatabase();
    storeChatMetadata('web:test', '2024-01-01T00:00:00.000Z');
  });
  afterEach(() => {
    _closeDatabase();
  });

  it('createPinThread + getPinsForChat round-trip', () => {
    createPinThread('pin-1', 'web:test', 'msg-X', 'block-a', 'Triage card');
    const pins = getPinsForChat('web:test');
    expect(pins).toHaveLength(1);
    expect(pins[0].thread_id).toBe('pin-1');
    expect(pins[0].pin_message_id).toBe('msg-X');
    expect(pins[0].pin_block_id).toBe('block-a');
    expect(pins[0].title).toBe('Triage card');
  });

  it('pin without block_id stores null', () => {
    createPinThread('pin-2', 'web:test', 'msg-Y', null, null);
    const pins = getPinsForChat('web:test');
    expect(pins[0].pin_block_id).toBeNull();
    expect(pins[0].title).toBeNull();
  });

  it('getPinByThreadId returns the pin', () => {
    createPinThread('pin-1', 'web:test', 'msg-X', null, null);
    const pin = getPinByThreadId('pin-1');
    expect(pin?.pin_message_id).toBe('msg-X');
  });

  it('getPinByThreadId returns undefined for non-pin threads', () => {
    // A trigger or portal thread with the same id should not be picked up.
    expect(getPinByThreadId('does-not-exist')).toBeUndefined();
  });

  it('deletePinThread returns true on success, false when missing', () => {
    createPinThread('pin-1', 'web:test', 'msg-X', null, null);
    expect(deletePinThread('pin-1')).toBe(true);
    expect(getPinsForChat('web:test')).toHaveLength(0);
    expect(deletePinThread('pin-1')).toBe(false);
  });

  it('scopes pins to chat — different jids do not bleed', () => {
    storeChatMetadata('web:other', '2024-01-01T00:00:00.000Z');
    createPinThread('pin-1', 'web:test', 'msg-X', null, null);
    createPinThread('pin-2', 'web:other', 'msg-Y', null, null);
    expect(getPinsForChat('web:test').map((p) => p.thread_id)).toEqual([
      'pin-1',
    ]);
    expect(getPinsForChat('web:other').map((p) => p.thread_id)).toEqual([
      'pin-2',
    ]);
  });
});

describe('renderPinnedSurfaces (#142)', () => {
  beforeEach(() => {
    _initTestDatabase();
    storeChatMetadata('web:test', '2024-01-01T00:00:00.000Z');
  });
  afterEach(() => {
    _closeDatabase();
  });

  it('returns empty string when no pins exist', () => {
    expect(renderPinnedSurfaces('web:test')).toBe('');
  });

  it('describes pins with message_id, block_id, title, and snippet', () => {
    storeMessage(
      msg({
        id: 'msg-X',
        content: 'Triage summary: 3 alerts pending.',
        sender_name: 'Andy',
        is_bot_message: true,
        timestamp: '2024-01-01T09:00:00.000Z',
      }),
    );
    createPinThread('pin-1', 'web:test', 'msg-X', 'deploy-card', 'Triage');
    const out = renderPinnedSurfaces('web:test');
    expect(out).toContain('Pinned surfaces');
    expect(out).toContain('msg-X');
    expect(out).toContain('deploy-card');
    expect(out).toContain('Triage');
    expect(out).toContain('Triage summary: 3 alerts pending.');
  });

  it('gracefully handles a pin whose source message was cleared', () => {
    createPinThread('pin-1', 'web:test', 'msg-missing', null, null);
    const out = renderPinnedSurfaces('web:test');
    expect(out).toContain('source message no longer exists');
  });

  it('truncates long content to keep the prompt block small', () => {
    const long = 'x'.repeat(2000);
    storeMessage(
      msg({
        id: 'msg-X',
        content: long,
        timestamp: '2024-01-01T09:00:00.000Z',
      }),
    );
    createPinThread('pin-1', 'web:test', 'msg-X', null, null);
    const out = renderPinnedSurfaces('web:test');
    // The default cap is 280 chars; the rendered output must be far shorter
    // than the raw 2000-char content.
    expect(out.length).toBeLessThan(600);
  });
});
