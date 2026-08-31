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

/**
 * Pulsatile flow specifically (a palpable pulse / a valid arterial or pleth
 * waveform at the sensor) - deliberately excludes support-only flow. Full
 * ECMO support perfuses without producing a pulse; that's the entire
 * clinical point of the perfusing/pulsatile split. This is the PATIENT'S
 * actual physiology, unaffected by either per-signal override below -
 * exported (not just an internal helper) for exactly one reason: a caller
 * summarizing overall patient status (e.g. the console readout's perfusion
 * pill) should reflect the patient, not one line's equipment/signal-quality
 * override - a dampened arterial line or a bad pulse-ox probe doesn't mean
 * the patient themselves isn't pulsatile. Shared derivation for both
 * isPulsatileArterial()/isPulsatilePleth() below - identical unless one has
 * been individually overridden.
 */
export function isPulsatileFromFlow(state) {
  return isNativeFlowPresent(state) || isCPRFlowPresent(state);
}

/**
 * `'pulsatile'`/`'nonpulsatile'` force the answer regardless of flow source;
 * `'auto'` (or unset) means "no override, use the flow-derived default" -
 * returns null so the caller falls through.
 */
function forcedPulsatility(mode) {
  if (mode === 'pulsatile') return true;
  if (mode === 'nonpulsatile') return false;
  return null;
}

/**
 * `state.pulseSignalArterial` / `state.pulseSignalPleth` (both default
 * `'auto'`) are direct facilitator overrides, a THIRD independent axis on
 * top of perfusing/pulsatile - separate from both, and deliberately separate
 * from EACH OTHER too. Originally one shared `pulseSignal` field; split on
 * direct user request: poor pulsatility on the pulse ox can be a probe
 * contact issue or genuine poor PERIPHERAL circulation with no bearing on
 * the actual arterial line, and a dampened/poorly-transduced arterial
 * waveform doesn't imply anything about peripheral perfusion either - two
 * different signal paths in real monitoring (a photoplethysmography probe
 * vs. a direct intra-arterial transducer), and conflating them into one
 * toggle couldn't represent either case alone.
 *
 * The original motivating case (still fully supported): "if I wanted
 * someone to have a pulse ox that is non pulsatile, I should be able to
 * show that... while at the same time generating whatever physical number I
 * want to show up, which would be indicative of someone with poor
 * perfusion." A real pulse ox can lose its pulsatile signal (severe
 * peripheral vasoconstriction, motion, a poor probe site) while the patient
 * is genuinely still perfusing centrally - a case the four-flow-source model
 * has no way to represent on its own, since every non-pulsatile case it
 * derives (arrest, PEA, VF) also isn't perfusing, and the one
 * perfusing-but-nonpulsatile case it DOES derive (ECMO) requires actually
 * cannulating the patient. `'auto'` preserves the pre-existing flow-derived
 * answer unchanged; forcing either field authors this exact teaching
 * scenario without needing a matching (and possibly unwanted) change to
 * rhythm/CPR/ECMO state, or to the OTHER signal. Deliberately does NOT touch
 * isPerfusing() - "poor signal" here is a pulsatility/signal-quality story,
 * not a claim the patient has actually arrested.
 */
export function isPulsatileArterial(state) {
  const forced = forcedPulsatility(state.pulseSignalArterial);
  return forced !== null ? forced : isPulsatileFromFlow(state);
}

export function isPulsatilePleth(state) {
  const forced = forcedPulsatility(state.pulseSignalPleth);
  return forced !== null ? forced : isPulsatileFromFlow(state);
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
        atLoss: { bp: { ...state.bp }, etco2: state.etco2, co: state.co, scvo2: state.scvo2 },
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
  return decayFromLoss(state, currentMinute, 'etco2', ETCO2_FLOOR_MMHG, ETCO2_DECAY_MINUTES);
}

/** Shared linear-decay-toward-a-floor logic for a no-flow-at-all state, used by getEffectiveETCO2 and getEffectiveScvO2 - see either function's docblock for why this shape (not an instant snap to floor, matching real physiology's gradual falloff) fits both. Falls back to the authored value if tickCirculation hasn't run yet / perfusion isn't actually marked lost, rather than guessing. */
function decayFromLoss(state, currentMinute, field, floor, decayMinutes) {
  const atLoss = state.circulation.atLoss;
  if (!atLoss || state.circulation.lastPerfusingAtMinute === null) return state[field];
  const elapsed = currentMinute - state.circulation.lastPerfusingAtMinute;
  if (elapsed >= decayMinutes) return floor;
  const fraction = Math.max(0, elapsed) / decayMinutes;
  return atLoss[field] + (floor - atLoss[field]) * fraction;
}

const CPR_CO_LPM = { good: 1.5, poor: 0.6 }; // representative "some real but severely reduced flow" values during compressions - NOT independently cited, same reasoning class as the onset/peak/duration timing values in formulary.js (internally consistent, not claimed as a validated PK/PD study number)

/**
 * What CO should actually read. Phase 7 (HemoSphere synchronization)
 * extension of the exact Phase 6 pattern already established for MAP/SBP/
 * DBP - native and support-only flow pass the authored value through
 * unchanged (no ECMO special-case, same reasoning as MAP); CPR uses fixed
 * representative low-flow values (compressions generate real but severely
 * reduced cardiac output, not a fraction of the pre-arrest number - CO
 * doesn't scale the same way MAP does, same reasoning getEffectiveETCO2
 * already uses for its CPR bands); no flow at all is exactly 0 (unlike
 * MAP's CPR-scaling nuance, CO genuinely is zero with no mechanism moving
 * blood at all - no snapshot/decay needed here).
 */
export function getEffectiveCO(state) {
  if (isNativeFlowPresent(state) || isSupportFlowPresent(state)) return state.co;
  if (isCPRFlowPresent(state)) return CPR_CO_LPM[state.circulation.cpr.quality];
  return 0;
}

/**
 * SVV/PPV (stroke-volume/pulse-pressure variation) are only clinically
 * interpretable with a real arterial waveform driven by mechanical
 * ventilation and organized cardiac activity - deliberately a simpler
 * binary rule than MAP/CO's multi-tier one: perfusing (native, CPR, or
 * support - any real flow at all) passes the authored value through
 * unchanged; no flow is 0 (matches how a real monitor would show an
 * invalid/unavailable reading rather than a number that implies a waveform
 * that doesn't exist).
 */
export function getEffectiveSVV(state) {
  return isPerfusing(state) ? state.svv : 0;
}

export function getEffectivePPV(state) {
  return isPerfusing(state) ? state.ppv : 0;
}

const CPR_SCVO2_PCT = { good: 45, poor: 25 }; // NOT independently cited (see docblock) - reasoned representative values for inadequate-but-present perfusion during compressions
const SCVO2_FLOOR_PCT = 15;
const SCVO2_DECAY_MINUTES = 2; // slower than etCO2's ~1 min - ScvO2 reflects accumulated tissue oxygen extraction from static, non-refreshed blood, not breath-to-breath gas exchange

/**
 * What venous oximetry (ScvO2) should actually read - Phase 7's
 * "coordinated with Phase 6's pulsatility model" goal. Same shape as
 * getEffectiveETCO2 (native/support passthrough, CPR uses fixed
 * representative values, no-flow-at-all decays from the value at the
 * moment perfusion was lost toward a floor) but NOT built from a real
 * cited threshold the way etCO2's CPR bands were - the available reference
 * library (AHA 2025 CPR/ECC volumes, STS-2017) doesn't cover central
 * venous oxygen saturation during CPR specifically (only found jugular
 * venous saturation in a post-arrest NEUROmonitoring context, a different
 * clinical question). Flagged plainly rather than presented as sourced -
 * revisit if a better reference turns up.
 */
export function getEffectiveScvO2(state, currentMinute) {
  if (isNativeFlowPresent(state) || isSupportFlowPresent(state)) return state.scvo2;
  if (isCPRFlowPresent(state)) return CPR_SCVO2_PCT[state.circulation.cpr.quality];
  return decayFromLoss(state, currentMinute, 'scvo2', SCVO2_FLOOR_PCT, SCVO2_DECAY_MINUTES);
}
