import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  getBlockStateForMessages,
  upsertBlockState,
} from './db.js';

describe('block_state overlay (#141)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });
  afterEach(() => {
    _closeDatabase();
  });

  it('upsert returns the merged state and stores it', () => {
    const row = upsertBlockState('msg-1', 'deploy-btn', {
      status: 'done',
      result: 'OK',
    });
    expect(row.message_id).toBe('msg-1');
    expect(row.block_id).toBe('deploy-btn');
    expect(row.state).toEqual({ status: 'done', result: 'OK' });

    const fetched = getBlockStateForMessages(['msg-1']);
    expect(fetched['msg-1']['deploy-btn']).toEqual({
      status: 'done',
      result: 'OK',
    });
  });

  it('shallow-merges subsequent updates over prior state', () => {
    upsertBlockState('msg-1', 'b', {
      status: 'pending',
      clicked_button_id: 'yes',
    });
    upsertBlockState('msg-1', 'b', { status: 'done', result: 'Deployed' });
    const fetched = getBlockStateForMessages(['msg-1']);
    expect(fetched['msg-1']['b']).toEqual({
      status: 'done',
      clicked_button_id: 'yes',
      result: 'Deployed',
    });
  });

  it('records updated_by for diagnostic visibility', () => {
    const row = upsertBlockState('msg-1', 'b', { x: 1 }, 'agent:analyst');
    expect(row.updated_by).toBe('agent:analyst');
  });

  it('keys updates by (message_id, block_id) — different messages do not collide', () => {
    upsertBlockState('msg-1', 'b', { value: 10 });
    upsertBlockState('msg-2', 'b', { value: 20 });
    const fetched = getBlockStateForMessages(['msg-1', 'msg-2']);
    expect(fetched['msg-1']['b']).toEqual({ value: 10 });
    expect(fetched['msg-2']['b']).toEqual({ value: 20 });
  });

  it('returns empty map for empty input', () => {
    expect(getBlockStateForMessages([])).toEqual({});
  });

  it('returns empty map when no rows exist for requested messages', () => {
    upsertBlockState('msg-X', 'b', { value: 1 });
    expect(getBlockStateForMessages(['msg-other'])).toEqual({});
  });

  it('returns multiple blocks for the same message keyed by block_id', () => {
    upsertBlockState('msg-1', 'block-a', { value: 1 });
    upsertBlockState('msg-1', 'block-b', { value: 2 });
    const fetched = getBlockStateForMessages(['msg-1']);
    expect(Object.keys(fetched['msg-1']).sort()).toEqual([
      'block-a',
      'block-b',
    ]);
    expect(fetched['msg-1']['block-a']).toEqual({ value: 1 });
    expect(fetched['msg-1']['block-b']).toEqual({ value: 2 });
  });
});
