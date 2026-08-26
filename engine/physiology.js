// Shared physiology state model for the CT surgery sim bundle.
//
// One state object is the single source of truth that IntelliVue, HemoSphere
// Alta, and the pacemaker all read from (Phase 2 wires the devices to it -
// this module has no knowledge of any device). Pure functions only: nothing
// here reads the clock or mutates its inputs, so it's trivially testable and
// safe to call from a UI render loop.

// Dot-paths of every field that a 'ramp' step is allowed to interpolate.
// Deliberately a whitelist, not "everything numeric": rhythm/pacer-mode/flags
// are semantically discrete and must change via an 'event' step, never ramp.
export const NUMERIC_PATHS = [
  'minute', 'hr',
  'bp.sbp', 'bp.dbp', 'bp.map',
  'pa.systolic', 'pa.diastolic',
  'cvp', 'co', 'ci', 'svr', 'svri', 'svv', 'ppv', 'scvo2', 'hpi', 'spo2', 'rr', 'temp', 'etco2', 'icp',
  'drips.epi', 'drips.levo', 'drips.milrinone', 'drips.propofol', 'drips.fentanyl', 'drips.vasopressin', 'drips.insulin',
  'chestTubes.rPleural', 'chestTubes.rMediastinal', 'chestTubes.blake', 'chestTubes.lPleural', 'chestTubes.lMediastinal',
  'urineOutput.volumeMl',
  'pacer.rate', 'pacer.outputMa', 'pacer.sensitivityMv',
];

// bp.map is an independently authored field, NEVER derived from sbp/dbp via
// the textbook (SBP+2*DBP)/3 formula. The source case study's charted MAPs
// don't consistently match that formula (e.g. "110/70 (73)" computes to 83,
// not 73) because a real arterial-line MAP reflects waveform/damping, not a
// clean calculation. Author bp.map exactly as charted in the source case.
const BASE_STATE = Object.freeze({
  minute: 0,
  rhythm: 'Normal Sinus Rhythm', // intrinsic/underlying rhythm - see getEffectiveRhythm
  hr: 80,
  bp: { sbp: 120, dbp: 70, map: 87 },
  pa: { systolic: 25, diastolic: 10 },
  cvp: 8,
  co: 5.0, ci: 2.5,
  svr: 1200, svri: 2000,
  svv: 10, ppv: 10,
  scvo2: 65,
  hpi: 0,
  spo2: 98,
  rr: 14,
  temp: 37.0,
  // Phase 6: previously a device-local-only field on IntelliVue, never
  // touched by the shared engine (confirmed gap - firing an 'event' step
  // like arrest zeroed rhythm/BP but never etco2, so the capnogram held a
  // stale pre-arrest plateau through a scripted code). Now a real authored
  // vital, same tier as rr/spo2/temp - see engine/clinical/pulsatility.js's
  // getEffectiveETCO2() for the perfusion-aware overlay that actually
  // decays this when perfusion is lost.
  etco2: 38,
  // Console UX overhaul: previously a device-local-only field on IntelliVue's
  // own native "practice scenario" mode (its own real ICP waveform/tile/
  // compliance model, never touched by the shared engine) - now a real
  // authored vital, same tier as cvp/temp. Deliberately NOT modeling ICP
  // compliance (P1/P2/P3 waveform morphology) here - that stays IntelliVue's
  // own local-practice-mode-only feature; the shared engine only needs the
  // mean ICP number for CPP = MAP - ICP (see computeCPP() below).
  icp: 10,
  drips: { epi: 0, levo: 0, milrinone: 0, propofol: 0, fentanyl: 0, vasopressin: 0, insulin: 0 },
  ivpb: null, // e.g. 'vancomycin' - an intermittent piggyback, not a continuous rate
  chestTubes: { rPleural: 0, rMediastinal: 0, blake: 0, lPleural: 0, lMediastinal: 0 },
  // Console UX overhaul: new. `deviceType` is discrete (facilitator-selected,
  // event-only, deliberately excluded from NUMERIC_PATHS - same reason
  // pacer.mode is excluded) - one of URINE_DEVICE_TYPES below. `volumeMl` is
  // a plain authored value the facilitator sets directly, matching
  // chestTubes' own simplicity (a documentation/charting number, not a
  // computed rate-over-time model) - confirmed with the user that device
  // type doesn't need to change how the number itself behaves.
  urineOutput: { deviceType: 'foley', volumeMl: 0 },
  pacer: { mode: 'off', rate: 0, outputMa: 0, sensitivityMv: 0, captured: false },
  flags: { arrestActive: false, sternotomyPerformed: false, ecmoCannulated: false },
  // Phase 5 (engine/clinical/pharmacology.js) - deliberately NOT in NUMERIC_PATHS
  // (arrays/maps, not a single ramp-able number) and never read directly by
  // getEffective*() overlays here; pharmacology.js reads it and composes its
  // OWN overlay functions on top of these, same "derived, never mutates
  // authored state" pattern as isPacing()/getEffectiveRhythm() below.
  medications: {
    pushes: [], // [{ drug: 'atropine', atMinute: 4.5, doseMg: 1 }, ...] - every administered IV push bolus, in order given
    infusionSetAtMinute: {}, // { epi: 12, levo: null, ... } - state.minute at which each drips.* field's CURRENT rate was last changed (null = never set / still at 0)
  },
  // Phase 6 (engine/clinical/pulsatility.js) - same "derived overlay, never
  // read directly by getEffective*() here" rule as medications above. `cpr`
  // is facilitator/learner-set (independent of rhythm - see
  // pulsatility-design.md's REVIEW #1 on why: a patient can present in an
  // organized-looking rhythm and still be pulseless, e.g. tamponade in
  // Sinus Rhythm, same physiology as PEA despite the rhythm string).
  // lastPerfusingAtMinute/atLoss are null while perfusing (nothing to
  // decay/scale from); pulsatility.js's tickCirculation() stamps both the
  // instant perfusion is lost (atLoss snapshots bp+etco2 at that exact
  // moment, since a subsequent arrest 'event' step may go on to zero those
  // same authored fields - the snapshot is what CPR-derived MAP/etCO2 scale
  // from, not whatever the live authored value has since become), and
  // clears both back to null the moment perfusion resumes. Same
  // state.minute-based pattern medications.infusionSetAtMinute established.
  circulation: {
    cpr: { active: false, quality: null }, // quality: 'good' | 'poor' | null
    lastPerfusingAtMinute: null,
    atLoss: null, // { bp: {sbp,dbp,map}, etco2, co, scvo2 } snapshotted at the instant perfusion was lost - co/scvo2 added Phase 7 (HemoSphere synchronization), same snapshot, same reason
  },
});

// Exported (not just internal to rampState) so scenarioRunner.js's override-
// release machinery can build/read single-path patches without duplicating
// this logic - see setOverrideWithRelease()/tickReleaseRamps() there.
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPathImmutable(obj, path, value) {
  const [head, ...rest] = path.split('.');
  if (rest.length === 0) return { ...obj, [head]: value };
  return { ...obj, [head]: setPathImmutable(obj[head] ?? {}, rest.join('.'), value) };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const result = { ...base };
  for (const key of Object.keys(patch)) {
    const val = patch[key];
    result[key] = isPlainObject(val) ? deepMerge(base?.[key] ?? {}, val) : val;
  }
  return result;
}

function flattenToPaths(obj, prefix = '') {
  const out = [];
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(val)) out.push(...flattenToPaths(val, path));
    else out.push([path, val]);
  }
  return out;
}

/** Build a full state object from a (possibly partial) snapshot, e.g. a scenario part's initialState. */
export function createState(overrides = {}) {
  return deepMerge(BASE_STATE, overrides);
}

/** Apply a discrete, immediate change (deep-merged). Used for 'instant' and 'event' steps, and facilitator overrides. */
export function applyInstant(state, patch) {
  return deepMerge(state, patch);
}

/**
 * Linearly interpolate the numeric fields named in targetPatch from their
 * current value in fromState toward targetPatch's value, at the given
 * fraction (0 = fromState, 1 = fully at target). Fields not mentioned in
 * targetPatch are left untouched - a ramp step only moves what it lists.
 * Throws if targetPatch names a field outside NUMERIC_PATHS (e.g. rhythm,
 * pacer.mode, flags.*) since those aren't meaningful to interpolate.
 */
export function rampState(fromState, targetPatch, fraction) {
  const clamped = Math.min(1, Math.max(0, fraction));
  let result = fromState;
  for (const [path, targetValue] of flattenToPaths(targetPatch)) {
    if (!NUMERIC_PATHS.includes(path)) {
      throw new Error(`rampState: "${path}" is not a ramp-able numeric field - use an 'event' step for discrete/non-numeric changes.`);
    }
    const fromValue = getPath(fromState, path) ?? 0;
    result = setPathImmutable(result, path, fromValue + (targetValue - fromValue) * clamped);
  }
  return result;
}

/**
 * Demand-inhibition: a demand pacer only actually paces when the intrinsic
 * rate falls below its programmed rate - if the intrinsic rate is faster, the
 * pacer senses those native beats and sits inhibited (never fires), so the
 * intrinsic rhythm/rate shows through even though the pacer is on and would
 * otherwise be capturing. "Captured" (state.pacer.captured) is a separate,
 * hardware-level concept - whether a delivered pacing spike would actually
 * depolarize the myocardium (output mA vs threshold) - and says nothing about
 * whether the pacer is currently being asked to fire at all. A paced rhythm
 * only shows when BOTH are true: capable of capturing, AND actually pacing
 * (intrinsic rate not fast enough to inhibit it).
 */
function isPacing(state) {
  return state.pacer.mode !== 'off' && state.pacer.captured && state.pacer.rate >= state.hr;
}

/**
 * What the ECG should actually display. See isPacing() for the full
 * capture-vs-demand-inhibition precedence. This is the pacer<->IntelliVue
 * feedback loop called for in BUILD_PROMPT.md's architecture decisions;
 * Phase 2 wires IntelliVue's ECG selection to call this instead of reading
 * state.rhythm directly.
 */
export function getEffectiveRhythm(state) {
  if (isPacing(state)) {
    return `Paced (${state.pacer.mode})`;
  }
  return state.rhythm;
}

/**
 * What the HR should actually read. Mirrors getEffectiveRhythm()'s precedence
 * exactly (see isPacing()): while the pacer is actually pacing, the patient's
 * observed rate IS the pacer's programmed rate (every captured beat lands
 * exactly on the paced interval) - not whatever the intrinsic/authored
 * state.hr says. Once the intrinsic rate rises above the programmed pacer
 * rate, the pacer is inhibited and the intrinsic rate shows through instead.
 */
export function getEffectiveHR(state) {
  if (isPacing(state)) {
    return state.pacer.rate;
  }
  return state.hr;
}

// Console UX overhaul: the three urine-collection-device options a
// facilitator can select for `state.urineOutput.deviceType`. A plain
// documentation/charting selector, not a mechanically-different input model
// (confirmed with the user) - every device type uses the same `volumeMl`
// field the same way.
export const URINE_DEVICE_TYPES = ['external', 'foley', 'urinal_bedpan'];

/**
 * Cerebral perfusion pressure = MAP - ICP. Deliberately a tiny, arity-2 pure
 * function rather than a `state`-reading `getEffective*()` overlay like every
 * other derived value in this file: CPP has no state of its own to read -
 * it's arithmetic on two values a caller has ALREADY resolved through
 * whatever composition layer is appropriate for their context (e.g. the
 * console's fully medicated/perfusion-aware MAP, or a device's own locally-
 * computed MAP) - callers pass those resolved numbers in rather than this
 * function re-deriving MAP itself and risking a second, divergent
 * composition path. Still exported and named, not inlined at each call site,
 * per this file's own "never inline-recompute a derived clinical value"
 * convention.
 */
export function computeCPP(map, icp) {
  return map - icp;
}
