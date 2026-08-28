import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, applyInstant, rampState, getEffectiveRhythm, getEffectiveHR, computeCPP, URINE_DEVICE_TYPES, RHYTHM_LIBRARY, jitterHR, PACER_MODES, isMonitored, MONITOR_GROUPS } from './physiology.js';

test('createState fills in full defaults with no overrides', () => {
  const s = createState();
  assert.equal(s.hr, 80);
  assert.equal(s.pacer.mode, 'off');
  assert.equal(s.flags.arrestActive, false);
});

test('createState defaults icp and urineOutput (Console UX overhaul additions)', () => {
  const s = createState();
  assert.equal(s.icp, 10);
  assert.equal(s.urineOutput.deviceType, 'foley');
  assert.equal(s.urineOutput.volumeMl, 0);
});

test('computeCPP is plain MAP - ICP arithmetic', () => {
  assert.equal(computeCPP(87, 10), 77);
  assert.equal(computeCPP(60, 10), 50);
  assert.equal(computeCPP(50, 60), -10); // negative CPP is a real, clinically meaningful (critical) value - not clamped
});

test('URINE_DEVICE_TYPES lists exactly the three confirmed device options', () => {
  assert.deepEqual(URINE_DEVICE_TYPES, ['external', 'foley', 'urinal_bedpan']);
});

test('createState defaults every MONITOR_GROUPS key to monitored (true)', () => {
  const s = createState();
  for (const key of Object.keys(MONITOR_GROUPS)) assert.equal(s.monitored[key], true, `${key} should default to monitored`);
});

test('isMonitored reads the live flag, and toggling one group leaves every other group untouched', () => {
  let s = createState();
  assert.equal(isMonitored(s, 'spo2'), true);
  s = applyInstant(s, { monitored: { spo2: false } });
  assert.equal(isMonitored(s, 'spo2'), false);
  assert.equal(isMonitored(s, 'hr'), true); // deep-merge, not a full overwrite of the monitored object
  assert.equal(isMonitored(s, 'bp'), true);
});

test('isMonitored defaults to true for a legacy state object that predates the `monitored` field entirely, and for an unrecognized key', () => {
  const legacyState = { hr: 80 }; // no `monitored` key at all - e.g. a pre-Round-4 scenario's raw baseline before createState() merges it
  assert.equal(isMonitored(legacyState, 'hr'), true);
  assert.equal(isMonitored(createState(), 'notARealGroup'), true);
});

test('MONITOR_GROUPS groups BP as one sys+dia+map toggle and PA as one sys+dia toggle, not per-number', () => {
  assert.deepEqual(MONITOR_GROUPS.bp, ['bp.sbp', 'bp.dbp', 'bp.map']);
  assert.deepEqual(MONITOR_GROUPS.pa, ['pa.systolic', 'pa.diastolic']);
});

test('createState defaults pulseSignal to "auto" (see pulsatility.js\'s isPulsatile for what this drives)', () => {
  assert.equal(createState().pulseSignal, 'auto');
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

test('getEffectiveRhythm shows the paced rhythm when the pacer is on, capturing, and its rate is at or above the intrinsic rate', () => {
  const s = createState({ hr: 70, rhythm: 'Sinus Bradycardia', pacer: { mode: 'DDD', captured: true, rate: 80 } });
  assert.equal(getEffectiveRhythm(s), 'Paced (DDD)');
});

test('getEffectiveRhythm shows the intrinsic rhythm when captured but demand-inhibited (intrinsic rate exceeds the programmed pacer rate)', () => {
  const s = createState({ hr: 90, rhythm: 'Sinus Rhythm', pacer: { mode: 'VVI', captured: true, rate: 60 } });
  assert.equal(getEffectiveRhythm(s), 'Sinus Rhythm');
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

test('getEffectiveHR shows the pacer\'s programmed rate when it exactly equals the intrinsic rate (boundary, still paces)', () => {
  const s = createState({ hr: 70, pacer: { mode: 'VVI', captured: true, rate: 70 } });
  assert.equal(getEffectiveHR(s), 70);
});

test('getEffectiveHR shows the intrinsic HR when captured but demand-inhibited (intrinsic rate exceeds the programmed pacer rate)', () => {
  const s = createState({ hr: 90, pacer: { mode: 'VVI', captured: true, rate: 50 } });
  assert.equal(getEffectiveHR(s), 90);
});

test('RHYTHM_LIBRARY: every entry has a valid defaultRate/regularity/waveform', () => {
  const validRegularity = new Set(['regular', 'irregular', 'regularly_irregular']);
  for (const [name, info] of Object.entries(RHYTHM_LIBRARY)) {
    assert.equal(typeof info.defaultRate, 'number', `${name}.defaultRate`);
    assert.ok(info.defaultRate >= 0, `${name}.defaultRate >= 0`);
    assert.ok(validRegularity.has(info.regularity), `${name}.regularity`);
    assert.equal(typeof info.waveform, 'string', `${name}.waveform`);
    assert.ok(info.waveform.length > 0, `${name}.waveform non-empty`);
  }
});

test('RHYTHM_LIBRARY includes every rhythm the pre-existing engine/UI already referenced (no silent narrowing)', () => {
  // The 7 rhythms console.html's <select> options and IntelliVue's RHYTHM_MAP
  // already relied on before this library existed - a regression here would
  // silently break an existing selectable value, not just fail to add new ones.
  const preExisting = ['Sinus Rhythm', 'Sinus Tachycardia', 'Sinus Bradycardia', 'Atrial Fibrillation', 'PEA', 'Ventricular Tachycardia', 'Ventricular Fibrillation'];
  for (const name of preExisting) assert.ok(name in RHYTHM_LIBRARY, name);
});

test('jitterHR returns the exact base rate unchanged for a regular rhythm, regardless of rand', () => {
  assert.equal(jitterHR(75, 'regular', () => 0), 75);
  assert.equal(jitterHR(75, 'regular', () => 1), 75);
});

test('jitterHR returns the exact base rate unchanged at rate 0 (asystole/vfib), even for an irregular regularity', () => {
  assert.equal(jitterHR(0, 'irregular', () => 1), 0);
});

test('jitterHR stays within the documented +/-20% band for "irregular" and is centered on the base rate', () => {
  const base = 80;
  const atMax = jitterHR(base, 'irregular', () => 1); // rand()=1 -> delta = +1*0.20*80 = +16
  const atMin = jitterHR(base, 'irregular', () => 0); // rand()=0 -> delta = -1*0.20*80 = -16
  const atMid = jitterHR(base, 'irregular', () => 0.5); // rand()=0.5 -> delta = 0
  assert.equal(atMax, 96);
  assert.equal(atMin, 64);
  assert.equal(atMid, 80);
});

test('jitterHR stays within the documented +/-8% (smaller) band for "regularly_irregular"', () => {
  const base = 60;
  assert.equal(jitterHR(base, 'regularly_irregular', () => 1), 65); // +1*0.08*60=4.8 -> round 65
  assert.equal(jitterHR(base, 'regularly_irregular', () => 0), 55); // -4.8 -> round 55
});

test('jitterHR floors at 0 defensively, even though a real rand() in [0,1) can never actually drive it negative', () => {
  // Amplitude is proportional to baseRate (max 20%), so delta magnitude is
  // always < baseRate for any real rand() in [0,1) - the floor is genuinely
  // unreachable via Math.random() itself. Exercised here only via an
  // out-of-spec injected rand, to confirm the defensive Math.max(0,...)
  // still holds if that invariant is ever violated (e.g. a future amplitude
  // change), not because normal use can trigger it.
  assert.equal(jitterHR(80, 'irregular', () => -10), 0);
});

test('PACER_MODES starts with "off" (the shared engine\'s existing pacer.mode default/sentinel) followed by every real Medtronic 5392 mode except the clinically-equivalent OOO', () => {
  assert.equal(PACER_MODES[0], 'off');
  assert.equal(PACER_MODES.length, 8);
  assert.deepEqual([...PACER_MODES].sort(), ['AAI', 'AOO', 'DDD', 'DDI', 'DOO', 'VOO', 'VVI', 'off'].sort());
  assert.ok(!PACER_MODES.includes('OOO')); // OOO (no pace, no sense) is clinically equivalent to 'off', deliberately not duplicated
});
