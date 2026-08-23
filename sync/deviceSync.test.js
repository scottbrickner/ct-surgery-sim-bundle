import test from 'node:test';
import assert from 'node:assert/strict';
import { genCode, shouldPush, shouldApplyRemote, isValidSnapshot, isValidGraphSnapshot } from './deviceSync.js';

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

test('isValidSnapshot accepts a well-formed {partIndex, stepIndex, state} snapshot', () => {
  assert.equal(isValidSnapshot({ partIndex: 0, stepIndex: -1, state: { hr: 90 } }), true);
  assert.equal(isValidSnapshot({ partIndex: 1, stepIndex: 3, state: {}, mode: 'training' }), true); // mode is optional
});

test('isValidSnapshot rejects a message from an unrelated system sharing the same relay room', () => {
  // shape of the pacemaker's OWN pre-existing sync message ({win, data}), which a bridge
  // consumer could receive if a user points both systems at the same relay code - see
  // CLAUDE.md's "pacer bridge mechanics" notes for why this collision is real, not hypothetical.
  assert.equal(isValidSnapshot({ win: 'abc', data: '{"s":{},"P":{},"conn":{},"N":{}}' }), false);
});

test('isValidSnapshot rejects missing/malformed fields', () => {
  assert.equal(isValidSnapshot(null), false);
  assert.equal(isValidSnapshot(undefined), false);
  assert.equal(isValidSnapshot({}), false);
  assert.equal(isValidSnapshot({ partIndex: 0, stepIndex: -1 }), false); // no state
  assert.equal(isValidSnapshot({ partIndex: '0', stepIndex: -1, state: {} }), false); // partIndex not a number
  assert.equal(isValidSnapshot({ partIndex: 0, stepIndex: -1, state: null }), false); // state is null
  assert.equal(isValidSnapshot({ partIndex: 0, stepIndex: -1, state: 'not-an-object' }), false);
});

test('isValidGraphSnapshot accepts a well-formed {currentStageId, state} v2 snapshot', () => {
  assert.equal(isValidGraphSnapshot({ currentStageId: 'stage-1', state: { hr: 90 } }), true);
  assert.equal(isValidGraphSnapshot({ currentStageId: 'arrest', state: {}, mode: 'training' }), true); // mode is optional
});

test('isValidGraphSnapshot rejects missing/malformed fields', () => {
  assert.equal(isValidGraphSnapshot(null), false);
  assert.equal(isValidGraphSnapshot(undefined), false);
  assert.equal(isValidGraphSnapshot({}), false);
  assert.equal(isValidGraphSnapshot({ currentStageId: 'stage-1' }), false); // no state
  assert.equal(isValidGraphSnapshot({ currentStageId: '', state: {} }), false); // empty stage id
  assert.equal(isValidGraphSnapshot({ currentStageId: 5, state: {} }), false); // not a string
  assert.equal(isValidGraphSnapshot({ currentStageId: 'stage-1', state: null }), false);
});

test('isValidSnapshot and isValidGraphSnapshot are mutually exclusive - a v1 snapshot never also looks like a v2 one and vice versa', () => {
  const v1 = { partIndex: 0, stepIndex: -1, state: { hr: 90 }, mode: 'training' };
  const v2 = { currentStageId: 'stage-1', state: { hr: 90 }, mode: 'training' };
  assert.equal(isValidSnapshot(v1), true);
  assert.equal(isValidGraphSnapshot(v1), false);
  assert.equal(isValidSnapshot(v2), false);
  assert.equal(isValidGraphSnapshot(v2), true);
});
