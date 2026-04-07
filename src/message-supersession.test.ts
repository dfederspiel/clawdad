import { beforeEach, describe, expect, it } from 'vitest';

import {
  beginDeliveryLease,
  markLeaseDelivered,
  noteVisibleMessage,
  resetChatSupersessionState,
  resetSupersessionState,
  shouldDeliverForLease,
} from './message-supersession.js';

describe('message supersession', () => {
  beforeEach(() => {
    resetSupersessionState();
  });

  it('allows repeated delivery from the same batch', () => {
    const lease = beginDeliveryLease('chat-1', 'batch-a');

    expect(shouldDeliverForLease(lease)).toBe(true);
    markLeaseDelivered(lease);
    expect(shouldDeliverForLease(lease)).toBe(true);
  });

  it('allows sibling leases from the same batch after one delivers', () => {
    const first = beginDeliveryLease('chat-1', 'batch-a');
    const second = beginDeliveryLease('chat-1', 'batch-a');

    markLeaseDelivered(first);

    expect(shouldDeliverForLease(second)).toBe(true);
  });

  it('suppresses an older batch after an unrelated visible message arrives', () => {
    const lease = beginDeliveryLease('chat-1', 'batch-a');

    noteVisibleMessage('chat-1', null);

    expect(shouldDeliverForLease(lease)).toBe(false);
  });

  it('suppresses an older batch after a newer batch delivers', () => {
    const older = beginDeliveryLease('chat-1', 'batch-a');
    const newer = beginDeliveryLease('chat-1', 'batch-b');

    markLeaseDelivered(newer);

    expect(shouldDeliverForLease(older)).toBe(false);
  });

  it('allows fan-out siblings after an interleaved different batch delivery', () => {
    const firstSibling = beginDeliveryLease('chat-1', 'batch-a');
    const secondSibling = beginDeliveryLease('chat-1', 'batch-a');

    markLeaseDelivered(firstSibling);
    markLeaseDelivered(beginDeliveryLease('chat-1', 'batch-b'));

    expect(shouldDeliverForLease(secondSibling)).toBe(true);
  });

  it('resets chat state cleanly', () => {
    const stale = beginDeliveryLease('chat-1', 'batch-a');
    noteVisibleMessage('chat-1', null);

    expect(shouldDeliverForLease(stale)).toBe(false);

    resetChatSupersessionState('chat-1');
    const fresh = beginDeliveryLease('chat-1', 'batch-b');

    expect(shouldDeliverForLease(fresh)).toBe(true);
  });
});
