// Phase 5 (Intervention & time-progression engine) - formulary-driven
// medication engine, sibling to engine/physiology.js rather than folded
// into it, per the audit's own guidance: "pulsatility, CPR, mechanical
// support, and pharmacology each as their own pure, tested module exposing
// read-time overlay functions in the same shape as getEffectiveRhythm/
// getEffectiveHR, composed together at render time rather than folded into
// one giant function." Every function here is pure (state in, value out;
// nothing reads the clock, nowMs/currentMinute is always a parameter) and
// nothing here EVER mutates state.medications/state.drips directly except
// the two state-changing functions explicitly named for it
// (administerPush/setInfusionRate) - every other function only READS state
// and DERIVES a value, exactly the isPacing()/getEffectiveRhythm() pattern
// this whole architecture is built around. See formulary.js for the actual
// dose/timing data and its sourcing.
//
// TWO EFFECT CURVES, two different clinical shapes:
//
// PUSH DRUGS (administerPush) - a bolus given once, whose effect rises then
// fades even if nothing else happens: 0 before onsetMinutes, linear rise to
// full effect at peakMinutes, linear decay back to 0 at durationMinutes.
// Repeated doses of the same drug (e.g. two atropine boluses) each get
// their own independent curve, summed - this is why atropine's real max-
// dose enforcement matters: without it, an unlimited stack of overlapping
// curves would let a facilitator drive HR arbitrarily high by spamming the
// button, which is not how the drug behaves and would teach the wrong
// lesson.
//
// CONTINUOUS INFUSIONS (setInfusionRate) - a rate that's SET and stays set;
// effect scales with (currentRate/maxRate) and, after any rate CHANGE,
// ramps in over onsetMinutes and then holds (no decay while the rate stays
// where it is - only a stop or reduction moves the effect back down, via
// the same rate-scaling term). This deliberately does not track "time since
// infusion started" globally, only "time since the CURRENT rate was set" -
// matches how a real titration works (turning epi up further has its own
// fresh onset lag for the NEW increment, not the whole infusion's history).

import { PUSH_DRUGS, INFUSIONS } from './formulary.js';
import { getEffectiveHR, applyInstant } from '../physiology.js';
import { getEffectiveMAP, getEffectiveCO, isPerfusing } from './pulsatility.js';

/** Every dose of `drugKey` given so far, in the order administered. */
export function getPushes(state, drugKey) {
  return state.medications.pushes.filter((p) => p.drug === drugKey);
}

export function getPushTotalDoseMg(state, drugKey) {
  return getPushes(state, drugKey).reduce((sum, p) => sum + p.doseMg, 0);
}

/**
 * Generalized version of getPushTotalDoseMg, for the Round 4 fluids/blood-
 * products/electrolyte entries that are naturally dosed in mL or units
 * instead of mg (see formulary.js's own docblock on ns_bolus/prbc/etc.) -
 * sums whichever dose-amount field each recorded push entry actually has.
 * getPushTotalDoseMg above is kept exactly as-is (unchanged, still mg-only)
 * for existing callers/tests that only ever exercise mg-dosed drugs.
 */
export function getPushTotalDoseAmount(state, drugKey) {
  return getPushes(state, drugKey).reduce((sum, p) => sum + (p.doseMg ?? p.doseMl ?? p.doseUnits ?? 0), 0);
}

export function getPushDoseCount(state, drugKey) {
  return getPushes(state, drugKey).length;
}

/**
 * Is it clinically/formulary-allowed to give `drugKey` right now? Checks
 * max total dose (atropine/metoprolol-style) and max dose COUNT (adenosine's
 * first-dose/second-dose model) - whichever the drug's formulary entry
 * defines. Returns { allowed, reason } rather than throwing, so a UI can
 * render "why is this disabled" without a try/catch; administerPush() below
 * still throws if called with allowed:false, since that indicates a caller
 * bug (UI should have disabled the control), not a normal runtime path.
 */
export function canAdministerPush(state, drugKey, currentMinute) {
  const drug = PUSH_DRUGS[drugKey];
  if (!drug) return { allowed: false, reason: `Unknown push drug: ${drugKey}` };
  const doses = getPushes(state, drugKey);
  if (typeof drug.maxDoses === 'number' && doses.length >= drug.maxDoses) {
    return { allowed: false, reason: `Maximum ${drug.maxDoses} doses of ${drug.label} already given.` };
  }
  if (typeof drug.maxTotalDoseMg === 'number') {
    const nextDoseMg = drug.doseMg;
    const totalSoFar = getPushTotalDoseMg(state, drugKey);
    if (totalSoFar + nextDoseMg > drug.maxTotalDoseMg) {
      return { allowed: false, reason: `Would exceed maximum total dose (${drug.maxTotalDoseMg} mg) of ${drug.label} - ${totalSoFar} mg already given.` };
    }
  }
  if (doses.length > 0 && typeof drug.repeatIntervalRangeMinutes?.[0] === 'number') {
    const last = doses[doses.length - 1];
    const sinceLast = currentMinute - last.atMinute;
    if (sinceLast < drug.repeatIntervalRangeMinutes[0]) {
      return { allowed: false, reason: `${drug.label} was given ${sinceLast.toFixed(1)} min ago - formulary interval is ${drug.repeatIntervalRangeMinutes[0]}-${drug.repeatIntervalRangeMinutes[1]} min.` };
    }
  }
  return { allowed: true, reason: null };
}

/**
 * Record one push dose of `drugKey` at `currentMinute` (state.minute, the
 * simulated case clock - NOT nowMs). Dose amount comes from the formulary -
 * a caller can't pick an arbitrary amount, matching how the real drug/
 * product is actually dosed. Throws if canAdministerPush() would return
 * allowed:false - see that function's docstring for why this is a
 * caller-bug signal, not a normal runtime path.
 *
 * Most drugs record their amount as `doseMg` (or the two-tier first/second
 * variant, e.g. adenosine); Round 4's fluids/blood-products/electrolyte
 * entries are naturally dosed in `doseMl` or `doseUnits` instead (see
 * formulary.js). Each drug defines exactly one of these fields, resolved in
 * this fixed priority order. `bolusDoseMg` (amiodarone) is a real,
 * previously-unresolved gap fixed here too: amiodarone has neither `doseMg`
 * nor `firstDoseMg`, so the OLD code recorded `doseMg: undefined` for every
 * amiodarone push - harmless in practice (amiodarone sets neither
 * maxTotalDoseMg nor anything else that reads it back), but still a real
 * bug now closed as a side effect of generalizing this resolution anyway.
 */
export function administerPush(state, drugKey, currentMinute) {
  const guard = canAdministerPush(state, drugKey, currentMinute);
  if (!guard.allowed) throw new Error(`administerPush: ${guard.reason}`);
  const drug = PUSH_DRUGS[drugKey];
  let entry;
  if (typeof drug.doseMg === 'number' || typeof drug.firstDoseMg === 'number' || typeof drug.bolusDoseMg === 'number') {
    const doseMg = typeof drug.doseMg === 'number'
      ? drug.doseMg
      : typeof drug.firstDoseMg === 'number'
        ? (getPushDoseCount(state, drugKey) === 0 ? drug.firstDoseMg : drug.secondDoseMg)
        : drug.bolusDoseMg;
    entry = { doseMg };
  } else if (typeof drug.doseMl === 'number') {
    entry = { doseMl: drug.doseMl };
  } else if (typeof drug.doseUnits === 'number') {
    entry = { doseUnits: drug.doseUnits };
  } else {
    entry = {};
  }
  return applyInstant(state, {
    medications: { pushes: [...state.medications.pushes, { drug: drugKey, atMinute: currentMinute, ...entry }] },
  });
}

/**
 * 0-1 intensity for one push dose at `currentMinute`: 0 before onset, rises
 * linearly to 1 at peak, decays linearly back to 0 at duration. See this
 * file's top docblock for why a bolus gets a rise-then-fade curve instead
 * of an infusion's rate-scaled hold.
 */
export function getPushEffectMultiplier(push, drugKey, currentMinute) {
  const drug = PUSH_DRUGS[drugKey];
  const elapsed = currentMinute - push.atMinute;
  if (elapsed <= drug.onsetMinutes) return 0;
  if (elapsed <= drug.peakMinutes) {
    const span = drug.peakMinutes - drug.onsetMinutes;
    return span <= 0 ? 1 : (elapsed - drug.onsetMinutes) / span;
  }
  if (elapsed <= drug.durationMinutes) {
    const span = drug.durationMinutes - drug.peakMinutes;
    return span <= 0 ? 0 : 1 - (elapsed - drug.peakMinutes) / span;
  }
  return 0;
}

/** Sum of every active push dose's contribution to `field` (e.g. 'hr'), across every drug that defines an effect on it. */
function getPushFieldDelta(state, field, currentMinute) {
  let total = 0;
  for (const drugKey of Object.keys(PUSH_DRUGS)) {
    const drug = PUSH_DRUGS[drugKey];
    const delta = drug.effect?.[field];
    if (typeof delta !== 'number') continue;
    for (const push of getPushes(state, drugKey)) {
      total += delta * getPushEffectMultiplier(push, drugKey, currentMinute);
    }
  }
  return total;
}

/**
 * Change a continuous infusion's rate at `currentMinute`. Only stamps a new
 * onset-window start (medications.infusionSetAtMinute[drugKey]) when the
 * rate actually CHANGES - re-setting the same rate (e.g. a UI re-render
 * calling this defensively) must not reset an onset window already in
 * progress. This intentionally does NOT validate against the formulary's
 * min/max/increment here - the existing override-release primitive and the
 * Console's slider bounds already constrain what rate a facilitator can
 * reach; this function's only job is recording WHEN the rate last changed.
 */
export function setInfusionRate(state, drugKey, rate, currentMinute) {
  const current = state.drips[drugKey];
  if (current === rate) return state;
  return applyInstant(state, {
    drips: { [drugKey]: rate },
    medications: { infusionSetAtMinute: { [drugKey]: currentMinute } },
  });
}

/**
 * 0-1 onset progress for the infusion CURRENTLY running at drugKey's rate:
 * 0 if the rate has never been set (infusionSetAtMinute is null/undefined),
 * else linear 0->1 over the drug's onsetMinutes, then holds at 1 - no decay
 * while the rate stays where it is (see this file's top docblock).
 */
export function getInfusionOnsetMultiplier(state, drugKey, currentMinute) {
  const setAt = state.medications.infusionSetAtMinute[drugKey];
  if (typeof setAt !== 'number') return 0;
  const drug = INFUSIONS[drugKey];
  if (!drug || !(drug.onsetMinutes > 0)) return 1;
  const elapsed = currentMinute - setAt;
  if (elapsed <= 0) return 0;
  if (elapsed >= drug.onsetMinutes) return 1;
  return elapsed / drug.onsetMinutes;
}

function getInfusionMaxRate(drug) {
  // maxRateMgPerMin (lidocaine/procainamide) and maxRatePpm (inhaled nitric
  // oxide) added for the Round 4 antiarrhythmic/inhaled-vasodilator
  // expansion - see formulary.js.
  return drug.maxRateMcgPerMin ?? drug.maxRateMcgPerKgPerMin ?? drug.maxRateMcgPerHr ?? drug.maxRateUnitsPerMin
    ?? drug.maxRateMgPerMin ?? drug.maxRatePpm ?? null;
}

/** This infusion's current contribution to `field`, scaled by both (currentRate/maxRate) and onset progress. */
function getInfusionFieldDelta(state, drugKey, field, currentMinute) {
  const drug = INFUSIONS[drugKey];
  const delta = drug?.effectAtMaxRate?.[field];
  if (typeof delta !== 'number') return 0;
  const maxRate = getInfusionMaxRate(drug);
  const currentRate = state.drips[drugKey] || 0;
  if (!maxRate || currentRate <= 0) return 0;
  const rateFraction = Math.min(1, currentRate / maxRate);
  const onset = getInfusionOnsetMultiplier(state, drugKey, currentMinute);
  return delta * rateFraction * onset;
}

/** Sum of every infusion's contribution to `field`. */
function getInfusionsFieldDelta(state, field, currentMinute) {
  let total = 0;
  for (const drugKey of Object.keys(INFUSIONS)) {
    if (drugKey === 'insulin') continue; // no effectAtMaxRate - not modeled, see formulary.js
    total += getInfusionFieldDelta(state, drugKey, field, currentMinute);
  }
  return total;
}

/** Combined push-drug + infusion delta for `field` at `currentMinute` - the one function every getMedicated*() wrapper below composes on top of the raw/pacer-aware value. */
export function getMedicationDelta(state, field, currentMinute) {
  return getPushFieldDelta(state, field, currentMinute) + getInfusionsFieldDelta(state, field, currentMinute);
}

/**
 * What HR should actually read once medication effects are layered on top
 * of pacer precedence. Composes with physiology.js's getEffectiveHR() -
 * pacer capture/demand-inhibition is resolved FIRST (that precedence is
 * unrelated to and unaffected by drugs), then medication delta is added on
 * top. A deliberate training simplification, stated plainly: a real
 * chronotropic drug's interaction with an actively-pacing heart is more
 * nuanced than a flat additive delta - this is the same class of
 * intentional simplification as the infusion effect-scaling model above.
 */
export function getMedicatedHR(state, currentMinute) {
  return getEffectiveHR(state) + getMedicationDelta(state, 'hr', currentMinute);
}

/**
 * Phase 6 composition note (added when pulsatility.js landed - see
 * engine/clinical/pulsatility-design.md): MAP/SVR/CO are hemodynamic
 * measures that genuinely can't exist without flow - a vasopressor infusion
 * cannot raise a MAP that fundamentally doesn't exist during true arrest,
 * no matter what rate it's running at. So these three gate their medication
 * delta on isPerfusing(state) (0 delta with no flow of any kind - native,
 * CPR, or mechanical support), and MAP additionally uses
 * getEffectiveMAP() as its base rather than the raw authored state.bp.map,
 * so it correctly reflects arrest/CPR-scaling/ECMO-passthrough BEFORE
 * medication effects layer on top - the same "resolve the non-drug
 * precedence first, then add drug delta" rule getMedicatedHR already
 * follows for pacer capture. getMedicatedHR/getMedicatedRR stay ungated -
 * a chronotropic drug's effect on the SA node and a sedative's effect on
 * the respiratory center are both real even without mechanical flow (PEA's
 * electrical rate still responds to atropine; fentanyl still depresses
 * respiration during CPR) - only the MECHANICAL/HEMODYNAMIC measures need
 * the flow gate.
 */
export function getMedicatedMAP(state, currentMinute) {
  const delta = isPerfusing(state) ? getMedicationDelta(state, 'map', currentMinute) : 0;
  return getEffectiveMAP(state) + delta;
}

export function getMedicatedSVR(state, currentMinute) {
  const delta = isPerfusing(state) ? getMedicationDelta(state, 'svr', currentMinute) : 0;
  return state.svr + delta;
}

export function getMedicatedCO(state, currentMinute) {
  const delta = isPerfusing(state) ? getMedicationDelta(state, 'co', currentMinute) : 0;
  return getEffectiveCO(state) + delta; // Phase 7: composes on getEffectiveCO (Phase 6's base layer) instead of raw state.co, mirroring getMedicatedMAP's fix - a CPR-augmenting drug (e.g. epi during arrest) can meaningfully boost compression-generated flow, so the delta still applies on top of CPR's representative low-flow value, same isPerfusing() gate as before
}

export function getMedicatedRR(state, currentMinute) {
  return state.rr + getMedicationDelta(state, 'rr', currentMinute);
}

/**
 * Round 4, direct user request: "inhaled nitric oxide/inhaled
 * epoprostonolol" - both are pulmonary-selective vasodilators whose entire
 * clinical point is lowering PA pressures specifically (without the
 * systemic MAP drop an IV pulmonary vasodilator would cause - see
 * formulary.js's own docblock on inhaledNO/epoprostenol). Composing this
 * effect required a real, new gap: unlike hr/map/svr/co/rr, PA pressures
 * had NO getMedicated*() wrapper at all before this - console.html and
 * IntelliVue both read raw state.pa.systolic/diastolic directly. Added
 * these two, layered on the raw authored value exactly like getMedicatedRR
 * does (no isPerfusing() gate - PA pressures aren't gated on flow anywhere
 * else in this engine either, so this doesn't newly introduce or remove
 * that behavior, just adds the medication layer on top of whatever was
 * already shown).
 */
export function getMedicatedPASys(state, currentMinute) {
  return state.pa.systolic + getMedicationDelta(state, 'paSys', currentMinute);
}

export function getMedicatedPADia(state, currentMinute) {
  return state.pa.diastolic + getMedicationDelta(state, 'paDia', currentMinute);
}
