import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../physiology.js';
import { createRunner, advanceSimClock } from '../scenarioRunner.js';
import {
  administerPush, canAdministerPush, getPushTotalDoseMg, getPushDoseCount,
  getPushEffectMultiplier, getMedicatedHR, getMedicatedMAP, getMedicatedSVR, getMedicatedCO, getMedicatedRR,
  setInfusionRate, getInfusionOnsetMultiplier, getMedicationDelta,
} from './pharmacology.js';
import { PUSH_DRUGS, INFUSIONS } from './formulary.js';

/* ---------------- administerPush / canAdministerPush ---------------- */

test('administerPush records a dose with the formulary amount, not a caller-chosen one', () => {
  const s = administerPush(createState(), 'atropine', 4);
  assert.equal(getPushDoseCount(s, 'atropine'), 1);
  assert.equal(getPushTotalDoseMg(s, 'atropine'), 1); // atropine.doseMg
  assert.equal(s.medications.pushes[0].atMinute, 4);
});

test('atropine: max total dose (3 mg) blocks a 4th 1 mg dose', () => {
  let s = createState();
  let minute = 0;
  for (let i = 0; i < 3; i++) {
    assert.equal(canAdministerPush(s, 'atropine', minute).allowed, true, `dose ${i + 1} should be allowed`);
    s = administerPush(s, 'atropine', minute);
    minute += 5; // clear of the repeat-interval guard
  }
  assert.equal(getPushTotalDoseMg(s, 'atropine'), 3);
  const guard = canAdministerPush(s, 'atropine', minute);
  assert.equal(guard.allowed, false);
  assert.match(guard.reason, /maximum total dose/i);
  assert.throws(() => administerPush(s, 'atropine', minute), /administerPush:/);
});

test('atropine: repeat-interval guard blocks a dose given too soon, allows it once the interval has passed', () => {
  let s = administerPush(createState(), 'atropine', 0);
  const tooSoon = canAdministerPush(s, 'atropine', 2); // formulary interval is 3-5 min
  assert.equal(tooSoon.allowed, false);
  assert.match(tooSoon.reason, /given.*ago/i);
  const okNow = canAdministerPush(s, 'atropine', 3);
  assert.equal(okNow.allowed, true);
});

test('adenosine: two-tier dosing gives 6 mg first, 12 mg second, and blocks a third dose', () => {
  let s = createState();
  s = administerPush(s, 'adenosine', 0);
  assert.equal(s.medications.pushes[0].doseMg, 6);
  s = administerPush(s, 'adenosine', 1);
  assert.equal(s.medications.pushes[1].doseMg, 12);
  const guard = canAdministerPush(s, 'adenosine', 2);
  assert.equal(guard.allowed, false);
  assert.match(guard.reason, /maximum 2 doses/i);
});

/* ---------------- getPushEffectMultiplier: onset -> peak -> duration curve ---------------- */

test('getPushEffectMultiplier: 0 before onset, rises linearly to 1 at peak, decays to 0 at duration', () => {
  const drug = PUSH_DRUGS.atropine; // onset 1, peak 3, duration 30
  const push = { drug: 'atropine', atMinute: 10, doseMg: 1 };
  assert.equal(getPushEffectMultiplier(push, 'atropine', 10), 0); // t=0 elapsed, before onset
  assert.equal(getPushEffectMultiplier(push, 'atropine', 10 + drug.onsetMinutes), 0); // exactly at onset boundary
  assert.equal(getPushEffectMultiplier(push, 'atropine', 10 + 2), 0.5); // halfway between onset(1) and peak(3)
  assert.equal(getPushEffectMultiplier(push, 'atropine', 10 + drug.peakMinutes), 1); // exactly at peak
  const midDecay = 10 + drug.peakMinutes + (drug.durationMinutes - drug.peakMinutes) / 2;
  assert.ok(Math.abs(getPushEffectMultiplier(push, 'atropine', midDecay) - 0.5) < 1e-9); // halfway through decay
  assert.equal(getPushEffectMultiplier(push, 'atropine', 10 + drug.durationMinutes), 0); // exactly at duration end
  assert.equal(getPushEffectMultiplier(push, 'atropine', 10 + drug.durationMinutes + 5), 0); // well past duration
});

/* ---------------- getMedicatedHR: push-drug effect actually moves HR ---------------- */

test('getMedicatedHR: atropine raises HR at peak, returns to baseline after duration elapses', () => {
  const baseline = createState({ hr: 50 }); // symptomatic bradycardia
  const s = administerPush(baseline, 'atropine', 0);
  assert.equal(getMedicatedHR(s, 0), 50); // t=0, not yet onset
  const drug = PUSH_DRUGS.atropine;
  assert.equal(getMedicatedHR(s, drug.peakMinutes), 50 + drug.effect.hr); // full effect at peak
  assert.equal(getMedicatedHR(s, drug.durationMinutes + 10), 50); // long after duration, back to baseline
});

test('getMedicatedHR: metoprolol lowers HR at peak (opposite sign from atropine)', () => {
  const baseline = createState({ hr: 140 }); // rapid rate needing control
  const s = administerPush(baseline, 'metoprolol', 0);
  const drug = PUSH_DRUGS.metoprolol;
  assert.equal(getMedicatedHR(s, drug.peakMinutes), 140 + drug.effect.hr); // effect.hr is negative
  assert.ok(getMedicatedHR(s, drug.peakMinutes) < 140);
});

test('getMedicatedHR: two atropine doses given minutes apart sum their overlapping curves', () => {
  let s = createState({ hr: 50 });
  s = administerPush(s, 'atropine', 0);
  s = administerPush(s, 'atropine', 5); // both still within each other's duration window
  const drug = PUSH_DRUGS.atropine;
  // at minute 5 + peak, dose #2 is at its own peak (+20) while dose #1 (given at 0) is partway through decay
  const delta1AtT = (() => {
    const elapsed = (5 + drug.peakMinutes) - 0;
    const span = drug.durationMinutes - drug.peakMinutes;
    return drug.effect.hr * Math.max(0, 1 - (elapsed - drug.peakMinutes) / span);
  })();
  const expected = 50 + drug.effect.hr /* dose #2 at its peak */ + delta1AtT;
  assert.ok(Math.abs(getMedicatedHR(s, 5 + drug.peakMinutes) - expected) < 1e-9);
});

/* ---------------- continuous infusions: rate scaling + onset ---------------- */

test('setInfusionRate only stamps a new onset window when the rate actually changes', () => {
  let s = setInfusionRate(createState(), 'levo', 5, 10);
  assert.equal(s.medications.infusionSetAtMinute.levo, 10);
  const s2 = setInfusionRate(s, 'levo', 5, 20); // same rate, later minute - should be a no-op
  assert.equal(s2, s); // same reference - confirms no-op, not just same value
  const s3 = setInfusionRate(s, 'levo', 10, 20); // real change - onset window resets
  assert.equal(s3.medications.infusionSetAtMinute.levo, 20);
});

test('getInfusionOnsetMultiplier: 0 before rate is ever set, ramps 0->1 over onsetMinutes, then holds at 1', () => {
  const fresh = createState();
  assert.equal(getInfusionOnsetMultiplier(fresh, 'levo', 100), 0);
  const s = setInfusionRate(fresh, 'levo', 10, 0);
  const onset = INFUSIONS.levo.onsetMinutes;
  assert.equal(getInfusionOnsetMultiplier(s, 'levo', 0), 0);
  assert.equal(getInfusionOnsetMultiplier(s, 'levo', onset / 2), 0.5);
  assert.equal(getInfusionOnsetMultiplier(s, 'levo', onset), 1);
  assert.equal(getInfusionOnsetMultiplier(s, 'levo', onset + 100), 1); // holds, no decay
});

test('getMedicatedMAP: norepinephrine at max rate and full onset contributes exactly effectAtMaxRate.map', () => {
  const baseline = createState({ bp: { sbp: 90, dbp: 55, map: 65 } });
  const maxRate = INFUSIONS.levo.maxRateMcgPerMin;
  const s = setInfusionRate(baseline, 'levo', maxRate, 0);
  const onset = INFUSIONS.levo.onsetMinutes;
  assert.equal(getMedicatedMAP(s, onset), 65 + INFUSIONS.levo.effectAtMaxRate.map);
});

test('getMedicatedMAP: half the max rate contributes half the effect (linear rate scaling)', () => {
  const baseline = createState({ bp: { sbp: 90, dbp: 55, map: 65 } });
  const halfRate = INFUSIONS.levo.maxRateMcgPerMin / 2;
  const s = setInfusionRate(baseline, 'levo', halfRate, 0);
  const onset = INFUSIONS.levo.onsetMinutes;
  const expected = 65 + INFUSIONS.levo.effectAtMaxRate.map * 0.5;
  assert.ok(Math.abs(getMedicatedMAP(s, onset) - expected) < 1e-9);
});

test('getMedicatedSVR: milrinone at max rate lowers SVR (negative effectAtMaxRate)', () => {
  const baseline = createState({ svr: 1400 });
  const maxRate = INFUSIONS.milrinone.maxRateMcgPerKgPerMin;
  const s = setInfusionRate(baseline, 'milrinone', maxRate, 0);
  const onset = INFUSIONS.milrinone.onsetMinutes;
  assert.ok(getMedicatedSVR(s, onset) < 1400);
  assert.equal(getMedicatedSVR(s, onset), 1400 + INFUSIONS.milrinone.effectAtMaxRate.svr);
});

test('insulin has no effectAtMaxRate and contributes nothing to getMedicationDelta (deliberate gap, not silently modeled)', () => {
  const s = setInfusionRate(createState(), 'insulin', 5, 0);
  assert.equal(getMedicationDelta(s, 'hr', 100), 0);
});

/* ---------------- global time-advance reconciliation (acceptance criteria) ---------------- */

test('advanceSimClock (scenarioRunner) + getMedicatedHR (pharmacology) reconcile end to end: fast-forwarding sim time actually moves a titrated drug\'s displayed effect, not just the clock', () => {
  let runner = createRunner({
    parts: [{ id: 'p1', title: 'P1', initialState: { hr: 50 }, steps: [] }],
  });
  assert.equal(runner.state.minute, 0);
  assert.equal(getMedicatedHR(runner.state, runner.state.minute), 50);

  runner = { ...runner, state: administerPush(runner.state, 'atropine', runner.state.minute) };
  assert.equal(getMedicatedHR(runner.state, runner.state.minute), 50); // just given, not yet onset

  const drug = PUSH_DRUGS.atropine;
  runner = advanceSimClock(runner, drug.peakMinutes);
  assert.equal(runner.state.minute, drug.peakMinutes); // the clock itself moved
  assert.equal(getMedicatedHR(runner.state, runner.state.minute), 50 + drug.effect.hr); // AND the drug's displayed effect moved with it

  runner = advanceSimClock(runner, drug.durationMinutes); // well past duration from the original dose
  assert.equal(getMedicatedHR(runner.state, runner.state.minute), 50); // effect has fully decayed back out
});

test('advanceSimClock is a no-op for zero/negative minutes (defensive, matches other engine functions\' guard style)', () => {
  const runner = createRunner({ parts: [{ id: 'p1', title: 'P1', initialState: {}, steps: [] }] });
  assert.equal(advanceSimClock(runner, 0), runner);
  assert.equal(advanceSimClock(runner, -5), runner);
});

/* ---------------- Phase 5/6 composition: medication effects require flow to act through ---------------- */

test('getMedicatedMAP: a vasopressor at max rate cannot raise MAP during true arrest (no flow of any kind) - correctly stays 0, not authored+delta', () => {
  let s = setInfusionRate(createState({ rhythm: 'PEA', bp: { sbp: 100, dbp: 55, map: 65 } }), 'levo', INFUSIONS.levo.maxRateMcgPerMin, 0);
  assert.equal(getMedicatedMAP(s, INFUSIONS.levo.onsetMinutes), 0); // effectively-perfusing MAP is 0 with no flow source; medication delta correctly does not apply on top of nothing
});

test('getMedicatedMAP: the same vasopressor DOES raise the CPR-derived MAP once compressions provide flow to act through', () => {
  let s = createState({ rhythm: 'Sinus Rhythm', bp: { sbp: 100, dbp: 60, map: 80 } });
  s = { ...s, rhythm: 'PEA' }; // perfusion lost
  // manually stamp the perfusion-loss snapshot the way tickCirculation would, without importing pulsatility.js's internals directly into this pharmacology test file
  s = { ...s, circulation: { ...s.circulation, lastPerfusingAtMinute: 0, atLoss: { bp: { ...s.bp }, etco2: s.etco2 } } };
  s = { ...s, circulation: { ...s.circulation, cpr: { active: true, quality: 'good' } } };
  s = setInfusionRate(s, 'levo', INFUSIONS.levo.maxRateMcgPerMin, 0);
  const withoutDrug = 80 * 0.45; // CPR-derived MAP alone, per pulsatility.js's CPR_MAP_FRACTION.good
  const withDrug = getMedicatedMAP(s, INFUSIONS.levo.onsetMinutes);
  assert.ok(withDrug > withoutDrug, 'a vasopressor should meaningfully augment CPR-generated MAP, not be silently dropped');
  assert.equal(withDrug, withoutDrug + INFUSIONS.levo.effectAtMaxRate.map);
});

test('getMedicatedHR/getMedicatedRR stay UNGATED by perfusion - electrical and respiratory-center drug effects persist even without mechanical flow (PEA still has an electrical rate atropine can raise; fentanyl still depresses respiration during CPR)', () => {
  let s = createState({ rhythm: 'PEA', hr: 50, rr: 14 });
  s = administerPush(s, 'atropine', 0);
  const drug = PUSH_DRUGS.atropine;
  assert.equal(getMedicatedHR(s, drug.peakMinutes), 50 + drug.effect.hr); // full effect despite zero flow - not gated
});

test('getMedicatedSVR/getMedicatedCO also gate their medication delta on isPerfusing, same reasoning as MAP', () => {
  let s = setInfusionRate(createState({ rhythm: 'PEA', svr: 1200, co: 4 }), 'milrinone', INFUSIONS.milrinone.maxRateMcgPerKgPerMin, 0);
  assert.equal(getMedicatedSVR(s, INFUSIONS.milrinone.onsetMinutes), 1200); // unchanged - no flow, no drug delta applied
  assert.equal(getMedicatedCO(s, INFUSIONS.milrinone.onsetMinutes), 4);
});
