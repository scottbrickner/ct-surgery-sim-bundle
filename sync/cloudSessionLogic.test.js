import test from 'node:test';
import assert from 'node:assert/strict';
import { canWriteChannel, sessionChannelName, parseSessionParams, buildSessionLink, shouldHydrate } from './cloudSessionLogic.js';

test('canWriteChannel: facilitator can write physiology, pacer_control, and assessments', () => {
  assert.equal(canWriteChannel('facilitator', 'physiology'), true);
  assert.equal(canWriteChannel('facilitator', 'pacer_control'), true);
  assert.equal(canWriteChannel('facilitator', 'assessments'), true);
});

test('canWriteChannel: learner can write assessments but NOT physiology or pacer_control - the Phase 9 acceptance criterion', () => {
  assert.equal(canWriteChannel('learner', 'assessments'), true);
  assert.equal(canWriteChannel('learner', 'physiology'), false);
  assert.equal(canWriteChannel('learner', 'pacer_control'), false);
});

test('canWriteChannel: an unrecognized role or channel is never granted write access', () => {
  assert.equal(canWriteChannel('observer', 'assessments'), false);
  assert.equal(canWriteChannel('facilitator', 'unknown_channel'), false);
  assert.equal(canWriteChannel(null, 'physiology'), false);
});

test('sessionChannelName builds a distinct name per (code, channel) pair', () => {
  assert.equal(sessionChannelName('K3RTQ9', 'physiology'), 'session:K3RTQ9:physiology');
  assert.notEqual(sessionChannelName('K3RTQ9', 'physiology'), sessionChannelName('K3RTQ9', 'assessments'));
  assert.notEqual(sessionChannelName('K3RTQ9', 'physiology'), sessionChannelName('OTHERC', 'physiology'));
});

test('parseSessionParams reads session/role/device, defaulting role to learner', () => {
  const sp = new URLSearchParams('session=k3rtq9&role=facilitator&device=console');
  assert.deepEqual(parseSessionParams(sp), { code: 'K3RTQ9', role: 'facilitator', device: 'console' });
});

test('parseSessionParams defaults to learner role and uppercases the code', () => {
  const sp = new URLSearchParams('session=abcdef');
  assert.deepEqual(parseSessionParams(sp), { code: 'ABCDEF', role: 'learner', device: null });
});

test('parseSessionParams returns a null code when no session param is present - the Cloud Session path stays off', () => {
  const sp = new URLSearchParams('role=learner');
  assert.equal(parseSessionParams(sp).code, null);
});

test('parseSessionParams rejects an unrecognized role value, falling back to learner (never grants facilitator by typo/injection)', () => {
  const sp = new URLSearchParams('session=abcdef&role=admin');
  assert.equal(parseSessionParams(sp).role, 'learner');
});

test('buildSessionLink produces a URL carrying session+role, and device only when given', () => {
  const link = buildSessionLink('https://ct-surgery-sim.netlify.app/devices/intellivue/intellivue_sim_monitor.html', 'K3RTQ9', { role: 'learner', device: 'intellivue' });
  const url = new URL(link);
  assert.equal(url.searchParams.get('session'), 'K3RTQ9');
  assert.equal(url.searchParams.get('role'), 'learner');
  assert.equal(url.searchParams.get('device'), 'intellivue');
  assert.equal(url.searchParams.has('relay'), false); // legacy WS-relay param never appears on a Cloud Session link
  assert.equal(url.searchParams.has('code'), false);
});

test('buildSessionLink omits device when not given', () => {
  const link = buildSessionLink('https://ct-surgery-sim.netlify.app/facilitator/console.html', 'K3RTQ9');
  assert.equal(new URL(link).searchParams.has('device'), false);
});

test('shouldHydrate: hydrates when nothing has been applied yet', () => {
  assert.equal(shouldHydrate({ rowUpdatedAtMs: 1000, lastAppliedAtMs: NaN }), true);
  assert.equal(shouldHydrate({ rowUpdatedAtMs: 1000, lastAppliedAtMs: undefined }), true);
});

test('shouldHydrate: hydrates only when the durable row is newer than what is already applied', () => {
  assert.equal(shouldHydrate({ rowUpdatedAtMs: 2000, lastAppliedAtMs: 1000 }), true);
  assert.equal(shouldHydrate({ rowUpdatedAtMs: 1000, lastAppliedAtMs: 2000 }), false);
  assert.equal(shouldHydrate({ rowUpdatedAtMs: 1000, lastAppliedAtMs: 1000 }), false); // equal - the live arm already has this exact value
});

test('shouldHydrate: never hydrates from a malformed/missing row timestamp', () => {
  assert.equal(shouldHydrate({ rowUpdatedAtMs: NaN, lastAppliedAtMs: 1000 }), false);
  assert.equal(shouldHydrate({ rowUpdatedAtMs: undefined, lastAppliedAtMs: 1000 }), false);
});
