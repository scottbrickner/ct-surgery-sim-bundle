import test from 'node:test';
import assert from 'node:assert/strict';
import { genCode, shouldPush, shouldApplyRemote } from './deviceSync.js';

test('genCode returns a 6-character code drawn only from the unambiguous alphabet', () => {
  for (let i = 0; i < 200; i++) {
    const c = genCode();
    assert.equal(c.length, 6);
    assert.match(c, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    assert.doesNotMatch(c, /[0O1I]/); // explicitly excluded - ambiguous when read aloud
  }
});

test('genCode is not the same value every call (sanity check it is actually randomized)', () => {
  const codes = new Set(Array.from({ length: 50 }, genCode));
  assert.ok(codes.size > 40); // collisions are possible but should be rare at 50 draws from 32^6
});

test('shouldPush is true when the snapshot changed', () => {
  assert.equal(shouldPush('{"hr":90}', '{"hr":80}'), true);
});

test('shouldPush is false when the snapshot is identical to what was last sent (dedupe)', () => {
  assert.equal(shouldPush('{"hr":90}', '{"hr":90}'), false);
});

test('shouldPush is true on the very first push (lastSentStr is null)', () => {
  assert.equal(shouldPush('{"hr":90}', null), true);
});

test('shouldApplyRemote rejects a message from our own window (self-echo guard)', () => {
  const msg = { win: 'abc123', data: '{"hr":90}' };
  assert.equal(shouldApplyRemote(msg, { winId: 'abc123', lastSyncStr: null }), false);
});

test('shouldApplyRemote accepts a message from a different window with new data', () => {
  const msg = { win: 'other', data: '{"hr":90}' };
  assert.equal(shouldApplyRemote(msg, { winId: 'abc123', lastSyncStr: null }), true);
});

test('shouldApplyRemote rejects data identical to what we already have (redundant heartbeat)', () => {
  const msg = { win: 'other', data: '{"hr":90}' };
  assert.equal(shouldApplyRemote(msg, { winId: 'abc123', lastSyncStr: '{"hr":90}' }), false);
});

test('shouldApplyRemote rejects malformed/missing messages', () => {
  assert.equal(shouldApplyRemote(null, { winId: 'abc123', lastSyncStr: null }), false);
  assert.equal(shouldApplyRemote({ win: 'other' }, { winId: 'abc123', lastSyncStr: null }), false); // no .data
  assert.equal(shouldApplyRemote({ win: 'other', data: 42 }, { winId: 'abc123', lastSyncStr: null }), false); // .data not a string
});
