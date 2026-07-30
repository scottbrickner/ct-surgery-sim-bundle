import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, applyInstant, rampState, getEffectiveRhythm, getEffectiveHR } from './physiology.js';

test('createState fills in full defaults with no overrides', () => {
  const s = createState();
  assert.equal(s.hr, 80);
  assert.equal(s.pacer.mode, 'off');
  assert.equal(s.flags.arrestActive, false);
});

test('createState deep-merges partial overrides without dropping sibling fields', () => {
  const s = createState({ bp: { sbp: 90 } });
  assert.equal(s.bp.sbp, 90);
  assert.equal(s.bp.dbp, 70); // untouched sibling from BASE_STATE
  assert.equal(s.bp.map, 87);
});

test('applyInstant deep-merges and does not mutate the original state', () => {
  const s0 = createState({ hr: 90 });
  const s1 = applyInstant(s0, { hr: 135, pa: { systolic: 45 } });
  assert.equal(s1.hr, 135);
  assert.equal(s1.pa.systolic, 45);
  assert.equal(s1.pa.diastolic, 10); // sibling preserved
  assert.equal(s0.hr, 90); // original untouched
});

test('rampState at fraction 0 stays at fromState values', () => {
  const from = createState({ hr: 100 });
  const r = rampState(from, { hr: 135 }, 0);
  assert.equal(r.hr, 100);
});

test('rampState at fraction 1 reaches the target exactly', () => {
  const from = createState({ hr: 100 });
  const r = rampState(from, { hr: 135 }, 1);
  assert.equal(r.hr, 135);
});

test('rampState at fraction 0.5 interpolates the midpoint', () => {
  const from = createState({ hr: 100, bp: { sbp: 110, dbp: 70, map: 73 } });
  const r = rampState(from, { hr: 135, bp: { sbp: 72, dbp: 58, map: 65 } }, 0.5);
  assert.equal(r.hr, 117.5);
  assert.equal(r.bp.sbp, 91);
  assert.equal(r.bp.dbp, 64);
  assert.equal(r.bp.map, 69);
});

test('rampState only touches fields named in the target patch', () => {
  const from = createState({ hr: 100, cvp: 8 });
  const r = rampState(from, { hr: 135 }, 0.5);
  assert.equal(r.cvp, 8); // untouched
});

test('rampState clamps fraction outside [0,1]', () => {
  const from = createState({ hr: 100 });
  assert.equal(rampState(from, { hr: 200 }, -0.5).hr, 100);
  assert.equal(rampState(from, { hr: 200 }, 1.5).hr, 200);
});

test('rampState rejects non-numeric fields (rhythm, pacer.mode, flags.*)', () => {
  const from = createState();
  assert.throws(() => rampState(from, { rhythm: 'PEA' }, 0.5), /not a ramp-able numeric field/);
  assert.throws(() => rampState(from, { pacer: { mode: 'DDD' } }, 0.5), /not a ramp-able numeric field/);
  assert.throws(() => rampState(from, { flags: { arrestActive: true } }, 0.5), /not a ramp-able numeric field/);
});

test('getEffectiveRhythm shows the intrinsic rhythm when the pacer is off', () => {
  const s = createState({ rhythm: 'Sinus Bradycardia', pacer: { mode: 'off', captured: false } });
  assert.equal(getEffectiveRhythm(s), 'Sinus Bradycardia');
});

test('getEffectiveRhythm shows the intrinsic rhythm on loss of capture (pacer on, not capturing)', () => {
  const s = createState({ rhythm: 'Sinus Bradycardia', pacer: { mode: 'DDD', captured: false } });
  assert.equal(getEffectiveRhythm(s), 'Sinus Bradycardia');
});

test('getEffectiveRhythm shows the paced rhythm when the pacer is on and capturing', () => {
  const s = createState({ rhythm: 'Sinus Bradycardia', pacer: { mode: 'DDD', captured: true } });
  assert.equal(getEffectiveRhythm(s), 'Paced (DDD)');
});

test('getEffectiveHR shows the intrinsic HR when the pacer is off', () => {
  const s = createState({ hr: 70, pacer: { mode: 'off', captured: false, rate: 80 } });
  assert.equal(getEffectiveHR(s), 70);
});

test('getEffectiveHR shows the intrinsic HR on loss of capture (pacer on, not capturing)', () => {
  const s = createState({ hr: 70, pacer: { mode: 'VVI', captured: false, rate: 80 } });
  assert.equal(getEffectiveHR(s), 70);
});

test('getEffectiveHR shows the pacer\'s programmed rate when on and capturing (pacer rate exceeds intrinsic)', () => {
  const s = createState({ hr: 70, pacer: { mode: 'VVI', captured: true, rate: 80 } });
  assert.equal(getEffectiveHR(s), 80);
});
