import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { attachQuotedContext } from './quote-reply.js';
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

describe('attachQuotedContext (#140)', () => {
  beforeEach(() => {
    _initTestDatabase();
    // FK from messages.chat_jid → chats.jid; seed the chat row.
    storeChatMetadata('web:test', '2024-01-01T00:00:00.000Z');
  });
  afterEach(() => {
    _closeDatabase();
  });

  it('no-ops when no message carries reply_to_message_id', () => {
    const incoming = [msg({ id: 'x', timestamp: '2024-01-01T09:00:00.000Z' })];
    attachQuotedContext(incoming, 'web:test', 'UTC');
    expect(incoming[0].quoted_context_xml).toBeUndefined();
    expect(incoming[0].quoted_context_text).toBeUndefined();
  });

  it('attaches XML and text variants for a replying message', () => {
    // Seed three messages in the chat — the anchor + one before + one after.
    storeMessage(
      msg({
        id: 'before',
        content: 'pre',
        sender_name: 'Alice',
        timestamp: '2024-01-01T08:59:00.000Z',
      }),
    );
    storeMessage(
      msg({
        id: 'anchor',
        content: 'anchor body',
        sender_name: 'Bob',
        timestamp: '2024-01-01T09:00:00.000Z',
      }),
    );
    storeMessage(
      msg({
        id: 'after',
        content: 'post',
        sender_name: 'Carol',
        timestamp: '2024-01-01T09:01:00.000Z',
      }),
    );

    const incoming = [
      msg({
        id: 'reply',
        content: 'follow up',
        timestamp: '2024-01-01T09:05:00.000Z',
        reply_to_message_id: 'anchor',
      }),
    ];
    attachQuotedContext(incoming, 'web:test', 'UTC');

    const xml = incoming[0].quoted_context_xml || '';
    expect(xml).toContain('>pre</message>');
    expect(xml).toContain('>anchor body</message>');
    expect(xml).toContain('>post</message>');
    expect(xml).toContain('anchor="true"');

    const text = incoming[0].quoted_context_text || '';
    expect(text).toContain('[Replying to an earlier message');
    expect(text).toContain('Bob: anchor body');
    expect(text).toContain('[End of quoted context]');
  });

  it('skips when the anchor does not exist in this chat', () => {
    const incoming = [
      msg({
        id: 'reply',
        timestamp: '2024-01-01T09:05:00.000Z',
        reply_to_message_id: 'missing-anchor',
      }),
    ];
    attachQuotedContext(incoming, 'web:test', 'UTC');
    expect(incoming[0].quoted_context_xml).toBeUndefined();
  });
});
