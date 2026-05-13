import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  createPinThread,
  deleteMessage,
  getBlockStateForMessages,
  getPinsForChat,
  getMessageById,
  storeChatMetadata,
  storeMessage,
  upsertBlockState,
} from './db.js';
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

describe('deleteMessage (#147)', () => {
  beforeEach(() => {
    _initTestDatabase();
    storeChatMetadata('web:test', '2024-01-01T00:00:00.000Z');
  });
  afterEach(() => {
    _closeDatabase();
  });

  it('removes the message row and reports it existed', () => {
    storeMessage(msg({ id: 'msg-1', timestamp: '2024-01-01T09:00:00.000Z' }));
    const summary = deleteMessage('web:test', 'msg-1');
    expect(summary.messageExisted).toBe(true);
    expect(getMessageById('msg-1', 'web:test')).toBeUndefined();
  });

  it('reports messageExisted=false for a missing id', () => {
    const summary = deleteMessage('web:test', 'no-such-message');
    expect(summary.messageExisted).toBe(false);
    expect(summary.blockStateRows).toBe(0);
    expect(summary.pinThreadIds).toEqual([]);
  });

  it('cascades block_state rows and returns the count', () => {
    storeMessage(msg({ id: 'msg-1', timestamp: '2024-01-01T09:00:00.000Z' }));
    upsertBlockState('msg-1', 'block-a', { status: 'done' });
    upsertBlockState('msg-1', 'block-b', { value: 42 });
    // Unrelated row that must survive
    upsertBlockState('msg-2', 'block-c', { ok: true });

    const summary = deleteMessage('web:test', 'msg-1');
    expect(summary.blockStateRows).toBe(2);
    expect(getBlockStateForMessages(['msg-1'])).toEqual({});
    expect(getBlockStateForMessages(['msg-2'])).toEqual({
      'msg-2': { 'block-c': { ok: true } },
    });
  });

  it('cascades pin threads anchored to this message and returns their ids', () => {
    storeMessage(msg({ id: 'msg-1', timestamp: '2024-01-01T09:00:00.000Z' }));
    storeMessage(msg({ id: 'msg-2', timestamp: '2024-01-01T09:01:00.000Z' }));
    createPinThread('pin-1', 'web:test', 'msg-1', null, 'message pin');
    createPinThread('pin-2', 'web:test', 'msg-1', 'block-a', 'block pin');
    createPinThread('pin-3', 'web:test', 'msg-2', null, 'unrelated pin');

    const summary = deleteMessage('web:test', 'msg-1');
    expect(summary.pinThreadIds.sort()).toEqual(['pin-1', 'pin-2']);
    const remaining = getPinsForChat('web:test');
    expect(remaining.map((p) => p.thread_id)).toEqual(['pin-3']);
  });

  it('leaves replies pointing at the deleted message alone (UI handles dangling)', () => {
    storeMessage(
      msg({ id: 'msg-orig', timestamp: '2024-01-01T09:00:00.000Z' }),
    );
    storeMessage(
      msg({
        id: 'msg-reply',
        timestamp: '2024-01-01T09:05:00.000Z',
        reply_to_message_id: 'msg-orig',
      }),
    );

    deleteMessage('web:test', 'msg-orig');
    const reply = getMessageById('msg-reply', 'web:test');
    // Reply still exists and still references the now-deleted anchor.
    expect(reply?.reply_to_message_id).toBe('msg-orig');
  });

  it('scopes deletion to the requesting chat — wrong jid leaves the row alone', () => {
    storeChatMetadata('web:other', '2024-01-01T00:00:00.000Z');
    storeMessage(msg({ id: 'msg-1', timestamp: '2024-01-01T09:00:00.000Z' }));
    const summary = deleteMessage('web:other', 'msg-1');
    expect(summary.messageExisted).toBe(false);
    expect(getMessageById('msg-1', 'web:test')).toBeDefined();
  });
});
