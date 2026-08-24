import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAssessmentState, addTile, updateTile, removeTile,
  requestTile, resolveRequest, getTileStatus, getPendingRequests, getSessionSummary,
} from './model.js';

function withTile(revealRule, extra = {}) {
  let s = createAssessmentState('flagship');
  s = addTile(s, { id: 'ct1', category: 'outputs', label: 'Chest Tube', revealRule, ...extra });
  return s;
}

/* ---------------- reveal-rule matrix (the audit's own named test surface) ---------------- */

test('reveal-rule matrix: auto reveals immediately on request', () => {
  let s = withTile('auto');
  s = requestTile(s, 'ct1', 1000);
  assert.equal(getTileStatus(s, 'ct1'), 'revealed');
  assert.equal(s.requests.ct1.requestedAtMs, 1000);
  assert.equal(s.requests.ct1.resolvedAtMs, 1000); // resolved in the same instant, no facilitator step
});

test('reveal-rule matrix: approve goes to pending, only reveals after facilitator approves', () => {
  let s = withTile('approve');
  s = requestTile(s, 'ct1', 1000);
  assert.equal(getTileStatus(s, 'ct1'), 'pending');
  assert.equal(s.requests.ct1.resolvedAtMs, null);
  s = resolveRequest(s, 'ct1', 'approve', 1500);
  assert.equal(getTileStatus(s, 'ct1'), 'revealed');
  assert.equal(s.requests.ct1.requestedAtMs, 1000);
  assert.equal(s.requests.ct1.resolvedAtMs, 1500);
});

test('reveal-rule matrix: approve can be denied instead of approved', () => {
  let s = withTile('approve');
  s = requestTile(s, 'ct1', 1000);
  s = resolveRequest(s, 'ct1', 'deny', 1200);
  assert.equal(getTileStatus(s, 'ct1'), 'denied');
});

test('reveal-rule matrix: hidden can never be requested - stays hidden regardless', () => {
  let s = withTile('hidden');
  assert.equal(getTileStatus(s, 'ct1'), 'hidden');
  s = requestTile(s, 'ct1', 1000);
  assert.equal(getTileStatus(s, 'ct1'), 'hidden'); // no-op, no request was created
  assert.equal(s.requests.ct1, undefined);
});

test('reveal-rule matrix: an unconfigured/unknown tile id has null status, not a thrown error', () => {
  const s = createAssessmentState('flagship');
  assert.equal(getTileStatus(s, 'nope'), null);
});

/* ---------------- request/reveal edge cases ---------------- */

test('requesting an already-pending tile again does not reset the original requestedAtMs (no duplicate request)', () => {
  let s = withTile('approve');
  s = requestTile(s, 'ct1', 1000);
  s = requestTile(s, 'ct1', 2000); // learner taps again while waiting
  assert.equal(s.requests.ct1.requestedAtMs, 1000);
  assert.equal(s.requests.ct1.status, 'pending');
});

test('requesting an already-revealed tile is a no-op', () => {
  let s = withTile('auto');
  s = requestTile(s, 'ct1', 1000);
  s = requestTile(s, 'ct1', 5000);
  assert.equal(s.requests.ct1.requestedAtMs, 1000);
});

test('resolveRequest on something that was never requested is a safe no-op', () => {
  const s = withTile('approve');
  const after = resolveRequest(s, 'ct1', 'approve', 1000);
  assert.equal(after, s); // same reference - confirms true no-op
});

test('resolveRequest on an already-resolved request is a safe no-op (can\'t un-approve/re-deny)', () => {
  let s = withTile('approve');
  s = requestTile(s, 'ct1', 1000);
  s = resolveRequest(s, 'ct1', 'approve', 1500);
  const after = resolveRequest(s, 'ct1', 'deny', 2000);
  assert.equal(after, s);
  assert.equal(getTileStatus(s, 'ct1'), 'revealed');
});

/* ---------------- tile CRUD ---------------- */

test('addTile auto-deduplicates ids, same convention as the Scenario Builder', () => {
  let s = createAssessmentState('x');
  s = addTile(s, { id: 'ct', category: 'outputs', label: 'A', revealRule: 'auto' });
  s = addTile(s, { id: 'ct', category: 'outputs', label: 'B', revealRule: 'auto' });
  assert.equal(s.tiles[0].id, 'ct');
  assert.equal(s.tiles[1].id, 'ct-2');
});

test('updateTile patches only the named tile, leaves others untouched', () => {
  let s = createAssessmentState('x');
  s = addTile(s, { id: 'a', category: 'outputs', label: 'A', revealRule: 'auto' });
  s = addTile(s, { id: 'b', category: 'outputs', label: 'B', revealRule: 'auto' });
  s = updateTile(s, 'a', { label: 'A updated', priority: true });
  assert.equal(s.tiles[0].label, 'A updated');
  assert.equal(s.tiles[0].priority, true);
  assert.equal(s.tiles[1].label, 'B');
});

test('removeTile drops the tile AND its request history', () => {
  let s = withTile('approve');
  s = requestTile(s, 'ct1', 1000);
  s = removeTile(s, 'ct1');
  assert.equal(s.tiles.length, 0);
  assert.equal(s.requests.ct1, undefined);
});

/* ---------------- facilitator pending-queue + delayed flag ---------------- */

test('getPendingRequests returns only pending requests, oldest first, flagging ones past the delay threshold', () => {
  let s = createAssessmentState('x');
  s = addTile(s, { id: 'a', category: 'outputs', label: 'A', revealRule: 'approve' });
  s = addTile(s, { id: 'b', category: 'outputs', label: 'B', revealRule: 'approve' });
  s = addTile(s, { id: 'c', category: 'outputs', label: 'C', revealRule: 'auto' }); // auto - never appears in the pending queue
  s = requestTile(s, 'b', 5000);
  s = requestTile(s, 'a', 1000); // requested earlier than b, despite being added second
  s = requestTile(s, 'c', 6000);
  const queue = getPendingRequests(s, 70000, 60000); // now=70000, 60s threshold
  assert.equal(queue.length, 2); // c is 'revealed' (auto), not in the queue
  assert.equal(queue[0].tileId, 'a'); // oldest first
  assert.equal(queue[1].tileId, 'b');
  assert.equal(queue[0].waitingMs, 69000);
  assert.equal(queue[0].delayed, true); // 69s >= 60s threshold
  assert.equal(queue[1].waitingMs, 65000);
  assert.equal(queue[1].delayed, true);
});

test('getPendingRequests: a request under the delay threshold is not flagged delayed', () => {
  let s = withTile('approve');
  s = requestTile(s, 'ct1', 1000);
  const queue = getPendingRequests(s, 30000, 60000); // only 29s waited, threshold 60s
  assert.equal(queue[0].delayed, false);
});

/* ---------------- session summary (in-session live counts, not a debrief report) ---------------- */

test('getSessionSummary: counts revealed/pending/denied/missed correctly, excludes hidden tiles from the total', () => {
  let s = createAssessmentState('x');
  s = addTile(s, { id: 'a', category: 'outputs', label: 'A', revealRule: 'auto' });
  s = addTile(s, { id: 'b', category: 'outputs', label: 'B', revealRule: 'approve' });
  s = addTile(s, { id: 'c', category: 'outputs', label: 'C', revealRule: 'approve' });
  s = addTile(s, { id: 'd', category: 'outputs', label: 'D', revealRule: 'auto' }); // never requested - "missed"
  s = addTile(s, { id: 'e', category: 'outputs', label: 'E', revealRule: 'hidden' }); // hidden - excluded from total entirely
  s = requestTile(s, 'a', 1000); // auto -> revealed
  s = requestTile(s, 'b', 1000);
  s = resolveRequest(s, 'b', 'approve', 1500); // -> revealed
  s = requestTile(s, 'c', 1000);
  s = resolveRequest(s, 'c', 'deny', 1500); // -> denied
  const summary = getSessionSummary(s);
  assert.deepEqual(summary, { total: 4, revealed: 2, pending: 0, denied: 1, missed: 1 });
});
