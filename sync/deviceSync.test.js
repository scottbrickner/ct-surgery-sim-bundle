import test from 'node:test';
import assert from 'node:assert/strict';
import { genCode, shouldPush, shouldBroadcast, shouldApplyRemote, isValidSnapshot, isValidGraphSnapshot, isValidAssessmentMessage, isValidPacerControlMessage } from './deviceSync.js';

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

test('shouldBroadcast: while paused, nothing broadcasts even if the state genuinely changed - the Phase 9 hidden-rehearsal mechanism', () => {
  assert.equal(shouldBroadcast({ paused: true, nextStr: '{"hr":90}', lastStr: '{"hr":80}' }), false);
  assert.equal(shouldBroadcast({ paused: true, nextStr: '{"hr":90}', lastStr: null }), false); // even the very-first-push case
});

test('shouldBroadcast: while unpaused, behaves exactly like shouldPush', () => {
  assert.equal(shouldBroadcast({ paused: false, nextStr: '{"hr":90}', lastStr: '{"hr":80}' }), true);
  assert.equal(shouldBroadcast({ paused: false, nextStr: '{"hr":90}', lastStr: '{"hr":90}' }), false);
  assert.equal(shouldBroadcast({ paused: false, nextStr: '{"hr":90}', lastStr: null }), true);
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

test('isValidAssessmentMessage accepts a well-formed {tiles, requests} Phase 8 payload', () => {
  assert.equal(isValidAssessmentMessage({ tiles: [], requests: {} }), true);
  assert.equal(isValidAssessmentMessage({ tiles: [{ id: 'a' }], requests: { a: { status: 'pending' } } }), true);
});

test('isValidAssessmentMessage rejects missing/malformed fields', () => {
  assert.equal(isValidAssessmentMessage(null), false);
  assert.equal(isValidAssessmentMessage(undefined), false);
  assert.equal(isValidAssessmentMessage({}), false);
  assert.equal(isValidAssessmentMessage({ tiles: [] }), false); // no requests
  assert.equal(isValidAssessmentMessage({ tiles: 'not-an-array', requests: {} }), false);
  assert.equal(isValidAssessmentMessage({ tiles: [], requests: null }), false);
  assert.equal(isValidAssessmentMessage({ tiles: [], requests: [] }), false); // an array is not a valid requests map
});

test('isValidAssessmentMessage is mutually exclusive with both physiology snapshot shapes - all three coexist safely on one channel', () => {
  const v1 = { partIndex: 0, stepIndex: -1, state: { hr: 90 } };
  const v2 = { currentStageId: 'stage-1', state: { hr: 90 } };
  const assessment = { tiles: [], requests: {} };
  assert.equal(isValidAssessmentMessage(v1), false);
  assert.equal(isValidAssessmentMessage(v2), false);
  assert.equal(isValidSnapshot(assessment), false);
  assert.equal(isValidGraphSnapshot(assessment), false);
});

test('isValidPacerControlMessage accepts a well-formed {s, P, conn, N} pacemaker control-panel payload', () => {
  assert.equal(isValidPacerControlMessage({ s: { mode: 'DDD', rate: 80 }, P: {}, conn: {}, N: {} }), true);
});

test('isValidPacerControlMessage rejects missing/malformed fields', () => {
  assert.equal(isValidPacerControlMessage(null), false);
  assert.equal(isValidPacerControlMessage(undefined), false);
  assert.equal(isValidPacerControlMessage({}), false);
  assert.equal(isValidPacerControlMessage({ s: {}, P: {} }), false); // no N (conn is allowed to be absent from the check but N is not - matches snapState()'s always-present fields)
  assert.equal(isValidPacerControlMessage({ s: null, P: {}, conn: {}, N: {} }), false);
  assert.equal(isValidPacerControlMessage({ s: [], P: {}, conn: {}, N: {} }), false); // array, not a plain object
});

test('isValidPacerControlMessage is mutually exclusive with all three other shapes - all four coexist safely on one channel', () => {
  const v1 = { partIndex: 0, stepIndex: -1, state: { hr: 90 } };
  const v2 = { currentStageId: 'stage-1', state: { hr: 90 } };
  const assessment = { tiles: [], requests: {} };
  const pacerControl = { s: { mode: 'DDD' }, P: {}, conn: {}, N: {} };

  assert.equal(isValidPacerControlMessage(v1), false);
  assert.equal(isValidPacerControlMessage(v2), false);
  assert.equal(isValidPacerControlMessage(assessment), false);

  assert.equal(isValidSnapshot(pacerControl), false);
  assert.equal(isValidGraphSnapshot(pacerControl), false);
  assert.equal(isValidAssessmentMessage(pacerControl), false);

  // and the real one is accepted
  assert.equal(isValidPacerControlMessage(pacerControl), true);
});
