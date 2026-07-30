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
  'cvp', 'co', 'ci', 'svr', 'svri', 'svv', 'ppv', 'scvo2', 'hpi', 'spo2', 'rr', 'temp',
  'drips.epi', 'drips.levo', 'drips.milrinone', 'drips.propofol', 'drips.fentanyl', 'drips.vasopressin', 'drips.insulin',
  'chestTubes.rPleural', 'chestTubes.rMediastinal', 'chestTubes.blake', 'chestTubes.lPleural', 'chestTubes.lMediastinal',
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
  drips: { epi: 0, levo: 0, milrinone: 0, propofol: 0, fentanyl: 0, vasopressin: 0, insulin: 0 },
  ivpb: null, // e.g. 'vancomycin' - an intermittent piggyback, not a continuous rate
  chestTubes: { rPleural: 0, rMediastinal: 0, blake: 0, lPleural: 0, lMediastinal: 0 },
  pacer: { mode: 'off', rate: 0, outputMa: 0, sensitivityMv: 0, captured: false },
  flags: { arrestActive: false, sternotomyPerformed: false, ecmoCannulated: false },
});

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPathImmutable(obj, path, value) {
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
 * What the ECG should actually display. If the pacer is on and capturing,
 * that's a paced rhythm (with spikes, on the device side). Otherwise - pacer
 * off, or on but NOT capturing (loss of capture) - the underlying intrinsic
 * rhythm shows through. This is the pacer<->IntelliVue feedback loop called
 * for in BUILD_PROMPT.md's architecture decisions; Phase 2 wires IntelliVue's
 * ECG selection to call this instead of reading state.rhythm directly.
 */
export function getEffectiveRhythm(state) {
  if (state.pacer.mode !== 'off' && state.pacer.captured) {
    return `Paced (${state.pacer.mode})`;
  }
  return state.rhythm;
}

/**
 * What the HR should actually read. Mirrors getEffectiveRhythm()'s precedence
 * exactly: while the pacer is on and capturing, the patient's observed rate
 * IS the pacer's programmed rate (every captured beat lands exactly on the
 * paced interval) - not whatever the intrinsic/authored state.hr says.
 *
 * KNOWN LIMITATION - does not model demand-inhibition: a captured pacer
 * programmed BELOW the intrinsic rate would, on a real device, sit inhibited
 * and let the faster intrinsic rhythm show through instead. This always
 * returns the paced rate whenever captured is true, regardless of how it
 * compares to state.hr. Fine for "pacer rate exceeds intrinsic" (the common
 * teaching case), wrong for "intrinsic exceeds a lower pacer rate" - revisit
 * if a scenario needs to teach demand-inhibition specifically.
 */
export function getEffectiveHR(state) {
  if (state.pacer.mode !== 'off' && state.pacer.captured) {
    return state.pacer.rate;
  }
  return state.hr;
}
