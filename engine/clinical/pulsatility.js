// Phase 6 (Philips physiological realism & BLS/ACLS, the audit's real
// numbering - see CLAUDE.md's phase-numbering note) - pulsatility, CPR, and
// mechanical-support-aware perfusion model. Sibling to physiology.js and
// pharmacology.js, same family, same rule: pure functions, state in ->
// value out, nothing here ever mutates authored state directly except
// tickCirculation() (explicitly named for it, same as pharmacology.js's
// administerPush/setInfusionRate). Every getEffective*() function here
// composes a derived value from authored state, exactly the
// isPacing()/getEffectiveRhythm() precedent in physiology.js - never a
// second, competing "what's the real value" mechanism.
//
// Full design rationale, the six reviewed judgment calls, and the approved
// state-matrix this file implements: engine/clinical/pulsatility-design.md
// (reviewed and approved 2026-08-24, read it before changing anything here).
//
// FOUR DISTINCT CONCEPTS, on purpose (see the design doc's "problem this
// solves" section for why conflating them was the bug):
//   1. Electrical rhythm  - state.rhythm, unchanged, existing field.
//   2. Mechanical activity - mechanicalActivity(state): 'organized' |
//      'fibrillating' | 'none'. Derived from rhythm PLUS flags.arrestActive
//      as a general override (not VT-specific - ANY organized-looking
//      rhythm can be pulseless, e.g. tamponade presenting in Sinus Rhythm).
//   3. Flow sources - native (mechanicalActivity==='organized'), CPR
//      (state.circulation.cpr.active), mechanical support
//      (flags.ecmoCannulated - ECMO only this pass, LVAD/Impella/IABP
//      deliberately deferred, each needs its own flow-profile reasoning
//      later, not a shared "mechanical support" bucket).
//   4. Perfusion vs pulsatility - TWO separate booleans. perfusing = any
//      flow source present. pulsatile = native OR CPR flow specifically -
//      support-only flow (full ECMO) is perfusing but NOT pulsatile. This
//      is the exact distinction the acceptance criteria are built on: a
//      nonpulsatile-but-ECMO-perfused patient must never render as arrest.

/** Mechanical activity - the ANSWER to "is the heart's muscle actually contracting", derived from electrical rhythm + the general pulseless override. */
export function mechanicalActivity(state) {
  if (state.rhythm === 'Ventricular Fibrillation') return 'fibrillating';
  if (state.rhythm === 'PEA') return 'none';
  if (state.flags.arrestActive) return 'none'; // general override - see design doc REVIEW #1: not just pulseless VT, any rhythm can present pulseless
  return 'organized';
}

export function isNativeFlowPresent(state) {
  return mechanicalActivity(state) === 'organized';
}

export function isCPRFlowPresent(state) {
  return !!(state.circulation.cpr.active && state.circulation.cpr.quality);
}

export function isSupportFlowPresent(state) {
  return !!state.flags.ecmoCannulated; // ECMO only this pass - see design doc's LVAD/Impella/IABP deferral note
}

export function isPerfusing(state) {
  return isNativeFlowPresent(state) || isCPRFlowPresent(state) || isSupportFlowPresent(state);
}

/** Pulsatile flow specifically (a palpable pulse) - deliberately excludes support-only flow. Full ECMO support perfuses without producing a pulse; that's the entire clinical point of the perfusing/pulsatile split. */
export function isPulsatile(state) {
  return isNativeFlowPresent(state) || isCPRFlowPresent(state);
}

const CPR_MAP_FRACTION = { good: 0.45, poor: 0.20 }; // midpoints of the design doc's 40-50%/15-25%-of-baseline bands
const CPR_ETCO2_MMHG = { good: 18, poor: 6 }; // representative values either side of the cited AHA 2025 >10mmHg (good) / <=10mmHg (poor) threshold - see pulsatility-design.md REVIEW #3
const ETCO2_FLOOR_MMHG = 4;
const ETCO2_DECAY_MINUTES = 1; // true arrest, no CPR: capnogram falls toward floor within about a minute of losing all flow

/**
 * Reactive bookkeeping, called every tick alongside the existing srTick/
 * checkOverrideReleases calls (same pattern - see facilitator/console.html's
 * consoleTick()). Detects the EDGE of losing or regaining perfusion (from
 * WHATEVER caused it - a scripted event step, a facilitator override, a
 * shock outcome - this doesn't care which) and snapshots/clears the
 * reference values getEffectiveMAP/getEffectiveETCO2 scale and decay from.
 * Idempotent - calling this every frame while perfusion state is unchanged
 * is a correct no-op (returns the same state reference).
 */
export function tickCirculation(state, currentMinute) {
  const perfusing = isPerfusing(state);
  const currentlyMarkedLost = state.circulation.lastPerfusingAtMinute !== null;
  if (!perfusing && !currentlyMarkedLost) {
    return {
      ...state,
      circulation: {
        ...state.circulation,
        lastPerfusingAtMinute: currentMinute,
        atLoss: { bp: { ...state.bp }, etco2: state.etco2 },
      },
    };
  }
  if (perfusing && currentlyMarkedLost) {
    return { ...state, circulation: { ...state.circulation, lastPerfusingAtMinute: null, atLoss: null } };
  }
  return state;
}

/** What MAP should actually read right now, given the active flow source(s). Native and support-only flow both pass the authored value through unchanged (the scenario author is responsible for what ECMO-supported MAP reads, same as they always have been for native MAP - see design doc REVIEW #4, no ECMO special-case). CPR-only scales DOWN from the value at the moment perfusion was lost, not the live authored value (which may since have been zeroed by an arrest event). */
export function getEffectiveMAP(state) {
  if (isNativeFlowPresent(state) || isSupportFlowPresent(state)) return state.bp.map;
  if (isCPRFlowPresent(state)) {
    const ref = state.circulation.atLoss?.bp.map ?? state.bp.map;
    return ref * CPR_MAP_FRACTION[state.circulation.cpr.quality];
  }
  return 0;
}

export function getEffectiveSBP(state) {
  if (isNativeFlowPresent(state) || isSupportFlowPresent(state)) return state.bp.sbp;
  if (isCPRFlowPresent(state)) {
    const ref = state.circulation.atLoss?.bp.sbp ?? state.bp.sbp;
    return ref * CPR_MAP_FRACTION[state.circulation.cpr.quality];
  }
  return 0;
}

export function getEffectiveDBP(state) {
  if (isNativeFlowPresent(state) || isSupportFlowPresent(state)) return state.bp.dbp;
  if (isCPRFlowPresent(state)) {
    const ref = state.circulation.atLoss?.bp.dbp ?? state.bp.dbp;
    return ref * CPR_MAP_FRACTION[state.circulation.cpr.quality];
  }
  return 0;
}

/**
 * What etCO2 should actually read. Native and support-only flow both pass
 * the authored value through unchanged (design doc REVIEW #4 - no ECMO
 * special-case, same code path as native). CPR uses fixed representative
 * values within the cited good/poor bands rather than scaling from a
 * baseline - the AHA citation is an ABSOLUTE threshold (>10mmHg vs
 * <=10mmHg), not a proportional relationship to a pre-arrest number, so
 * scaling would misrepresent the guideline. No flow at all: linear decay
 * from the value at the moment perfusion was lost toward a floor over
 * ETCO2_DECAY_MINUTES - this is what closes the confirmed gap (capnogram no
 * longer holds a stale pre-arrest plateau through an unaddressed arrest).
 */
export function getEffectiveETCO2(state, currentMinute) {
  if (isNativeFlowPresent(state) || isSupportFlowPresent(state)) return state.etco2;
  if (isCPRFlowPresent(state)) return CPR_ETCO2_MMHG[state.circulation.cpr.quality];
  const atLoss = state.circulation.atLoss;
  if (!atLoss || state.circulation.lastPerfusingAtMinute === null) return state.etco2; // tickCirculation hasn't run yet / not actually lost - fall back to authored value rather than guessing
  const elapsed = currentMinute - state.circulation.lastPerfusingAtMinute;
  if (elapsed >= ETCO2_DECAY_MINUTES) return ETCO2_FLOOR_MMHG;
  const fraction = Math.max(0, elapsed) / ETCO2_DECAY_MINUTES;
  return atLoss.etco2 + (ETCO2_FLOOR_MMHG - atLoss.etco2) * fraction;
}
