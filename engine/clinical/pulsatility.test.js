import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../physiology.js';
import {
  mechanicalActivity, isNativeFlowPresent, isCPRFlowPresent, isSupportFlowPresent,
  isPerfusing, isPulsatile, tickCirculation, getEffectiveMAP, getEffectiveSBP, getEffectiveDBP,
  getEffectiveETCO2, getEffectiveCO, getEffectiveSVV, getEffectivePPV, getEffectiveScvO2,
} from './pulsatility.js';

/* ---------------- mechanicalActivity() ---------------- */

test('mechanicalActivity: Ventricular Fibrillation is always fibrillating, regardless of arrestActive', () => {
  const s = createState({ rhythm: 'Ventricular Fibrillation' });
  assert.equal(mechanicalActivity(s), 'fibrillating');
});

test('mechanicalActivity: PEA is always none, regardless of arrestActive', () => {
  const s = createState({ rhythm: 'PEA' });
  assert.equal(mechanicalActivity(s), 'none');
});

test('mechanicalActivity: an organized rhythm with arrestActive:true is none (the general pulseless override - e.g. tamponade presenting in Sinus Rhythm)', () => {
  const s = createState({ rhythm: 'Sinus Rhythm', flags: { arrestActive: true } });
  assert.equal(mechanicalActivity(s), 'none');
});

test('mechanicalActivity: pulseless VT is Ventricular Tachycardia + arrestActive:true', () => {
  const s = createState({ rhythm: 'Ventricular Tachycardia', flags: { arrestActive: true } });
  assert.equal(mechanicalActivity(s), 'none');
});

test('mechanicalActivity: VT WITHOUT arrestActive is organized (VT-with-a-pulse)', () => {
  const s = createState({ rhythm: 'Ventricular Tachycardia', flags: { arrestActive: false } });
  assert.equal(mechanicalActivity(s), 'organized');
});

test('mechanicalActivity: any ordinary rhythm with arrestActive false is organized', () => {
  for (const rhythm of ['Sinus Rhythm', 'Sinus Tachycardia', 'Sinus Bradycardia', 'Atrial Fibrillation']) {
    assert.equal(mechanicalActivity(createState({ rhythm, flags: { arrestActive: false } })), 'organized', rhythm);
  }
});

/* ---------------- full state-matrix (rhythm x CPR x ECMO), per pulsatility-design.md ---------------- */

function withCPR(state, quality) {
  return { ...state, circulation: { ...state.circulation, cpr: { active: !!quality, quality } } };
}
function withECMO(state, on) {
  return { ...state, flags: { ...state.flags, ecmoCannulated: on } };
}
function arrestState() {
  return createState({ rhythm: 'PEA' });
}
function organizedState() {
  return createState({ rhythm: 'Sinus Rhythm' });
}

test('matrix: organized rhythm, no CPR, no ECMO -> perfusing AND pulsatile', () => {
  const s = organizedState();
  assert.equal(isPerfusing(s), true);
  assert.equal(isPulsatile(s), true);
});

test('matrix: Ventricular Fibrillation, no CPR, no ECMO -> NOT perfusing, NOT pulsatile (genuine arrest)', () => {
  const s = createState({ rhythm: 'Ventricular Fibrillation' });
  assert.equal(isPerfusing(s), false);
  assert.equal(isPulsatile(s), false);
});

test('matrix: PEA, no CPR, no ECMO -> NOT perfusing, NOT pulsatile (genuine arrest, the exact bug this phase fixes - old perfusing() logic treated PEA as perfusing)', () => {
  const s = arrestState();
  assert.equal(isPerfusing(s), false);
  assert.equal(isPulsatile(s), false);
});

test('matrix: pulseless VT (VT + arrestActive), no CPR, no ECMO -> NOT perfusing, NOT pulsatile', () => {
  const s = createState({ rhythm: 'Ventricular Tachycardia', flags: { arrestActive: true } });
  assert.equal(isPerfusing(s), false);
  assert.equal(isPulsatile(s), false);
});

test('matrix: any non-organized rhythm + good CPR, no ECMO -> perfusing AND pulsatile (compressions)', () => {
  const s = withCPR(arrestState(), 'good');
  assert.equal(isPerfusing(s), true);
  assert.equal(isPulsatile(s), true);
});

test('matrix: any non-organized rhythm + poor CPR, no ECMO -> still perfusing AND pulsatile (weaker, but still real compressions)', () => {
  const s = withCPR(arrestState(), 'poor');
  assert.equal(isPerfusing(s), true);
  assert.equal(isPulsatile(s), true);
});

test('matrix: any non-organized rhythm, no CPR, ECMO ON -> perfusing but NOT pulsatile (the core acceptance criterion: nonpulsatile-but-ECMO-perfused must never read as arrest)', () => {
  const s = withECMO(arrestState(), true);
  assert.equal(isPerfusing(s), true);
  assert.equal(isPulsatile(s), false);
});

test('matrix: organized rhythm, no CPR, ECMO ON -> perfusing AND pulsatile (native pulse dominates, ECMO incidental)', () => {
  const s = withECMO(organizedState(), true);
  assert.equal(isPerfusing(s), true);
  assert.equal(isPulsatile(s), true);
});

test('matrix: any non-organized rhythm + good CPR + ECMO ON -> perfusing AND pulsatile (CPR contributes the pulse)', () => {
  const s = withECMO(withCPR(arrestState(), 'good'), true);
  assert.equal(isPerfusing(s), true);
  assert.equal(isPulsatile(s), true);
});

test('isNativeFlowPresent/isCPRFlowPresent/isSupportFlowPresent are independent flags, not derived from each other', () => {
  const s = withECMO(withCPR(organizedState(), 'poor'), true);
  assert.equal(isNativeFlowPresent(s), true);
  assert.equal(isCPRFlowPresent(s), true);
  assert.equal(isSupportFlowPresent(s), true);
});

test('CPR flow requires BOTH active:true and a quality set - active alone (quality null) is not a flow source', () => {
  const s = { ...arrestState(), circulation: { ...arrestState().circulation, cpr: { active: true, quality: null } } };
  assert.equal(isCPRFlowPresent(s), false);
  assert.equal(isPerfusing(s), false);
});

/* ---------------- tickCirculation: edge detection + snapshot bookkeeping ---------------- */

test('tickCirculation: transitioning from perfusing to not-perfusing snapshots bp+etco2+co+scvo2 and stamps the minute', () => {
  let s = organizedState();
  s = { ...s, bp: { sbp: 118, dbp: 64, map: 82 }, etco2: 38, co: 5.2, scvo2: 68 };
  assert.equal(s.circulation.lastPerfusingAtMinute, null);
  s = { ...s, rhythm: 'PEA' }; // perfusion just lost
  s = tickCirculation(s, 12.5);
  assert.equal(s.circulation.lastPerfusingAtMinute, 12.5);
  assert.deepEqual(s.circulation.atLoss, { bp: { sbp: 118, dbp: 64, map: 82 }, etco2: 38, co: 5.2, scvo2: 68 });
});

test('tickCirculation: repeated calls while still not-perfusing are a no-op (same reference, snapshot not re-taken)', () => {
  let s = { ...arrestState() };
  s = tickCirculation(s, 5);
  const afterFirst = s;
  s = tickCirculation(s, 6); // still not perfusing - must not overwrite the minute-5 snapshot
  assert.equal(s, afterFirst);
  assert.equal(s.circulation.lastPerfusingAtMinute, 5);
});

test('tickCirculation: regaining perfusion (e.g. ROSC) clears lastPerfusingAtMinute and atLoss back to null', () => {
  let s = tickCirculation(arrestState(), 5);
  assert.notEqual(s.circulation.lastPerfusingAtMinute, null);
  s = { ...s, rhythm: 'Sinus Rhythm' }; // ROSC
  s = tickCirculation(s, 5.3);
  assert.equal(s.circulation.lastPerfusingAtMinute, null);
  assert.equal(s.circulation.atLoss, null);
});

test('tickCirculation: no-op while perfusion state is unchanged (perfusing the whole time)', () => {
  const s = organizedState();
  assert.equal(tickCirculation(s, 10), s);
});

/* ---------------- getEffectiveMAP / SBP / DBP ---------------- */

test('getEffectiveMAP: native flow passes the authored value straight through', () => {
  const s = createState({ rhythm: 'Sinus Rhythm', bp: { sbp: 110, dbp: 60, map: 77 } });
  assert.equal(getEffectiveMAP(s), 77);
});

test('getEffectiveMAP: ECMO-only passes the authored value straight through too - no ECMO special-case (design doc REVIEW #4)', () => {
  const s = withECMO(createState({ rhythm: 'PEA', bp: { sbp: 100, dbp: 55, map: 65 } }), true);
  assert.equal(getEffectiveMAP(s), 65);
});

test('getEffectiveMAP: no flow at all is 0, regardless of what the authored bp.map still says', () => {
  const s = createState({ rhythm: 'PEA', bp: { sbp: 100, dbp: 55, map: 65 } });
  assert.equal(getEffectiveMAP(s), 0);
});

test('getEffectiveMAP: CPR scales from the value AT THE MOMENT PERFUSION WAS LOST, not the live authored value', () => {
  let s = organizedState();
  s = { ...s, bp: { sbp: 118, dbp: 64, map: 82 } };
  s = { ...s, rhythm: 'PEA' };
  s = tickCirculation(s, 8); // snapshots map:82 as atLoss
  s = { ...s, bp: { sbp: 0, dbp: 0, map: 0 } }; // a scripted arrest 'event' step zeroing the authored pressures, as the flagship JSON already does
  s = withCPR(s, 'good');
  assert.equal(getEffectiveMAP(s), 82 * 0.45); // scales from the SNAPSHOT (82), not the live authored 0
});

test('getEffectiveMAP: good CPR scales higher than poor CPR from the same reference value', () => {
  let s = tickCirculation({ ...organizedState(), bp: { sbp: 100, dbp: 60, map: 80 }, rhythm: 'PEA' }, 0);
  const good = getEffectiveMAP(withCPR(s, 'good'));
  const poor = getEffectiveMAP(withCPR(s, 'poor'));
  assert.ok(good > poor);
  assert.equal(good, 80 * 0.45);
  assert.equal(poor, 80 * 0.20);
});

test('getEffectiveSBP/getEffectiveDBP follow the identical rule as MAP (native/ECMO passthrough, CPR scales from snapshot, none is 0)', () => {
  const native = createState({ rhythm: 'Sinus Rhythm', bp: { sbp: 118, dbp: 64, map: 82 } });
  assert.equal(getEffectiveSBP(native), 118);
  assert.equal(getEffectiveDBP(native), 64);
  const none = createState({ rhythm: 'PEA', bp: { sbp: 100, dbp: 55, map: 65 } });
  assert.equal(getEffectiveSBP(none), 0);
  assert.equal(getEffectiveDBP(none), 0);
});

/* ---------------- getEffectiveETCO2 ---------------- */

test('getEffectiveETCO2: native flow passes the authored value straight through', () => {
  const s = createState({ rhythm: 'Sinus Rhythm', etco2: 40 });
  assert.equal(getEffectiveETCO2(s, 0), 40);
});

test('getEffectiveETCO2: ECMO-only passes the authored value straight through too - same as native, no special-case', () => {
  const s = withECMO(createState({ rhythm: 'PEA', etco2: 36 }), true);
  assert.equal(getEffectiveETCO2(s, 0), 36);
});

test('getEffectiveETCO2: good CPR reads above the cited 10mmHg threshold, poor CPR at or below it', () => {
  const base = createState({ rhythm: 'PEA', etco2: 38 });
  const good = getEffectiveETCO2(withCPR(base, 'good'), 0);
  const poor = getEffectiveETCO2(withCPR(base, 'poor'), 0);
  assert.ok(good > 10, `good CPR etCO2 (${good}) should read above the AHA 2025 >10mmHg threshold`);
  assert.ok(poor <= 10, `poor CPR etCO2 (${poor}) should read at or below the AHA 2025 threshold`);
});

test('getEffectiveETCO2: no flow at all decays linearly from the value at perfusion loss toward the floor, reaching it by the decay window', () => {
  let s = createState({ rhythm: 'Sinus Rhythm', etco2: 38 });
  s = { ...s, rhythm: 'PEA' };
  s = tickCirculation(s, 10); // atLoss.etco2 = 38, lastPerfusingAtMinute = 10
  assert.equal(getEffectiveETCO2(s, 10), 38); // t=0 elapsed - still at the pre-loss value
  const mid = getEffectiveETCO2(s, 10.5); // halfway through the 1-minute decay window
  assert.ok(Math.abs(mid - (38 + (4 - 38) * 0.5)) < 1e-9);
  assert.equal(getEffectiveETCO2(s, 11), 4); // exactly at the decay window - floor
  assert.equal(getEffectiveETCO2(s, 20), 4); // well past - holds at floor, never negative or stale-high
});

test('getEffectiveETCO2: this is what closes the confirmed gap - an unaddressed arrest does NOT hold its pre-arrest plateau', () => {
  let s = createState({ rhythm: 'Sinus Rhythm', etco2: 40 });
  s = tickCirculation({ ...s, rhythm: 'PEA' }, 0);
  assert.notEqual(getEffectiveETCO2(s, 5), 40); // 5 minutes unaddressed - must have moved off the pre-arrest value
  assert.equal(getEffectiveETCO2(s, 5), 4); // and specifically be at the decayed floor by then
});

/* ---------------- Phase 7 (HemoSphere synchronization): getEffectiveCO/SVV/PPV/ScvO2 ---------------- */
// Acceptance criterion: "No combination of severe unsupported deterioration
// or arrest leaves CO/CI/SVV/venous-O2 looking normal." These extend the
// exact pattern already established and reviewed for MAP/SBP/DBP/etCO2 -
// no new clinical judgment calls, per the audit's own Phase 7 framing
// ("HemoSphere's registry reads the new pulsatility overlay the same way
// IntelliVue does").

test('getEffectiveCO: native and ECMO-only both pass the authored value straight through unchanged', () => {
  assert.equal(getEffectiveCO(createState({ rhythm: 'Sinus Rhythm', co: 5.2 })), 5.2);
  assert.equal(getEffectiveCO(withECMO(createState({ rhythm: 'PEA', co: 4.0 }), true)), 4.0);
});

test('getEffectiveCO: no flow at all is exactly 0 - CO cannot exist with nothing moving blood', () => {
  assert.equal(getEffectiveCO(createState({ rhythm: 'PEA', co: 5.2 })), 0);
});

test('getEffectiveCO: CPR produces real but severely reduced flow, good > poor, neither anywhere near the pre-arrest baseline', () => {
  const base = createState({ rhythm: 'PEA', co: 5.2 });
  const good = getEffectiveCO(withCPR(base, 'good'));
  const poor = getEffectiveCO(withCPR(base, 'poor'));
  assert.ok(good > poor);
  assert.ok(good < 5.2 && poor < 5.2, 'CPR-generated CO should never read as if it were the normal pre-arrest baseline');
});

test('getEffectiveSVV/getEffectivePPV: pass the authored value through during ANY real flow (native, CPR, or ECMO), 0 with none at all', () => {
  const organized = createState({ rhythm: 'Sinus Rhythm', svv: 12, ppv: 11 });
  assert.equal(getEffectiveSVV(organized), 12);
  assert.equal(getEffectivePPV(organized), 11);
  const cpr = withCPR(createState({ rhythm: 'PEA', svv: 12, ppv: 11 }), 'good');
  assert.equal(getEffectiveSVV(cpr), 12);
  const none = createState({ rhythm: 'PEA', svv: 12, ppv: 11 });
  assert.equal(getEffectiveSVV(none), 0);
  assert.equal(getEffectivePPV(none), 0);
});

test('getEffectiveScvO2: native and ECMO-only pass the authored value through; CPR reads a representative reduced value; no flow decays toward a low floor', () => {
  const native = createState({ rhythm: 'Sinus Rhythm', scvo2: 68 });
  assert.equal(getEffectiveScvO2(native, 0), 68);
  const ecmo = withECMO(createState({ rhythm: 'PEA', scvo2: 68 }), true);
  assert.equal(getEffectiveScvO2(ecmo, 0), 68);
  const cprBase = createState({ rhythm: 'PEA', scvo2: 68 });
  const goodCPR = getEffectiveScvO2(withCPR(cprBase, 'good'), 0);
  const poorCPR = getEffectiveScvO2(withCPR(cprBase, 'poor'), 0);
  assert.ok(goodCPR > poorCPR);
  assert.ok(goodCPR < 68, 'CPR-supported ScvO2 should never read as normal as the pre-arrest baseline');
});

test('getEffectiveScvO2: no flow at all decays from the pre-loss value toward the floor over the decay window, never holding stale-high', () => {
  let s = createState({ rhythm: 'Sinus Rhythm', scvo2: 70 });
  s = tickCirculation({ ...s, rhythm: 'PEA' }, 0);
  assert.equal(getEffectiveScvO2(s, 0), 70); // t=0 - still at pre-loss value
  assert.ok(getEffectiveScvO2(s, 1) < 70); // moving toward the floor
  assert.equal(getEffectiveScvO2(s, 2), 15); // fully decayed by the 2-minute window
  assert.equal(getEffectiveScvO2(s, 10), 15); // holds at floor, never negative
});

/* ---------------- cross-device consistency (the actual Phase 7 acceptance test) ---------------- */
// The audit's own framing: "for a given underlying state, IntelliVue and
// HemoSphere never disagree about perfusion/arrest status, even though each
// computes its own displayed numbers independently." This is true by
// CONSTRUCTION, not by coincidence - both devices call these exact
// functions rather than each maintaining their own rhythm-string logic
// (see CLAUDE.md's Phase 6 notes on IntelliVue's perfusing()/pulsatile()
// wiring and HemoSphere's applyEngineValuesLight). This test is the
// structural guarantee that makes that true: isPerfusing/isPulsatile are
// pure functions of `state` alone, so any two callers - a facilitator
// console, IntelliVue, HemoSphere, or a test - looking at the identical
// state object are mathematically guaranteed to get the identical answer.
// There is no way for the two devices to disagree without one of them
// having its own separate, un-reviewed copy of this logic, which neither
// does.
test('cross-device consistency: isPerfusing/isPulsatile are pure functions of state alone - any two callers looking at the same state get the same answer, by construction', () => {
  const scenarios = [
    createState({ rhythm: 'Sinus Rhythm' }),
    createState({ rhythm: 'Ventricular Fibrillation' }),
    createState({ rhythm: 'PEA' }),
    withCPR(createState({ rhythm: 'PEA' }), 'good'),
    withCPR(createState({ rhythm: 'PEA' }), 'poor'),
    withECMO(createState({ rhythm: 'PEA' }), true),
    withECMO(createState({ rhythm: 'Sinus Rhythm' }), true),
    withECMO(withCPR(createState({ rhythm: 'PEA' }), 'good'), true),
  ];
  for (const s of scenarios) {
    // Simulate two independent "devices" reading the same state - neither
    // passes anything device-specific into these functions, so there is no
    // parameter through which they COULD diverge.
    const deviceA = { perfusing: isPerfusing(s), pulsatile: isPulsatile(s) };
    const deviceB = { perfusing: isPerfusing(s), pulsatile: isPulsatile(s) };
    assert.deepEqual(deviceA, deviceB);
  }
});
