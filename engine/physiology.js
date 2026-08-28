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
  // Direct user request: "we need to make sure that we are able to fully
  // toggle on and off various vital signs in the patient assessments and
  // outputs" - distinct from isPerfusing()/isPulsatile() (which describe the
  // PATIENT's actual physiology) and distinct from a raw value being
  // authored (which can already be anything, including 0, per the separate
  // "no limits" request). This models whether a parameter is currently BEING
  // MONITORED at all - e.g. no PA catheter placed yet, an oximetry cable
  // unplugged, no ICP bolt - independent of what the underlying authored
  // number is. A group toggled off shows as "not connected" (see
  // isMonitored()/MONITOR_GROUPS below) on every surface that displays it,
  // while the number keeps being tracked underneath so switching back on
  // shows it immediately - matching HemoSphere's own pre-existing
  // paramAvailable()/"Connect sensor" convention, generalized here so it
  // works consistently across the console readout AND both real device
  // shells instead of being HemoSphere-only. All true by default (matches
  // every pre-Round-4 scenario's actual behavior - nothing was ever
  // "unmonitored" before this field existed) - deepMerge() means an existing
  // scenario JSON that never mentions `monitored` still gets this full
  // default map for free, zero migration needed.
  monitored: {
    hr: true, bp: true, pa: true, cvp: true, co: true, svv: true, ppv: true,
    scvo2: true, spo2: true, rr: true, temp: true, icp: true,
  },
});

// Which state paths each togglable monitoring group covers - e.g. the "bp"
// group is sys+dia+map together (one arterial line, one on/off switch), not
// three independent toggles, matching how a real monitor has one pressure
// line per site, not one per number derived from it. Exported so
// console.html can build one checkbox per group without hand-duplicating
// this list, same convention as NUMERIC_PATHS/OVERRIDE_MAP elsewhere.
export const MONITOR_GROUPS = {
  hr: ['hr'],
  bp: ['bp.sbp', 'bp.dbp', 'bp.map'],
  pa: ['pa.systolic', 'pa.diastolic'],
  cvp: ['cvp'],
  co: ['co'],
  svv: ['svv'],
  ppv: ['ppv'],
  scvo2: ['scvo2'],
  spo2: ['spo2'],
  rr: ['rr'],
  temp: ['temp'],
  icp: ['icp'],
};

/** Is `group` (a MONITOR_GROUPS key) currently being monitored? Defensively defaults true for a legacy state object that predates this field entirely, or an unrecognized key - "unknown" should never silently read as "hidden." */
export function isMonitored(state, group) {
  return state.monitored?.[group] !== false;
}

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

// Round 3 rhythm-library expansion, direct user request: "expand library of
// ECG rhythms; note their default rates, regularity, waveforms" plus
// "if learner selects Sinus Tachycardia it defaults to a HR > 100... set to
// 120." Representative rates are drawn from this program's own vetted ECG
// teaching-tracing library (real tracings used in the parallel ECG/ACLS
// course, not invented for this simulator) - each is a typical/teaching
// value for that rhythm category, not a claim that real patients never
// present outside this range. Selecting a rhythm applies `defaultRate` as a
// normal, still-freely-editable HR override (see console.html's setRhythm) -
// a one-time convenience, not an ongoing constraint.
//
// `regularity` drives jitterHR() below:
//   'regular'            - no jitter, the set rate displays exactly.
//   'regularly_irregular' - a patterned irregularity (e.g. Wenckebach's
//                           progressively-dropped-beat grouping, or a 2nd-
//                           degree Type II block's intermittent non-conducted
//                           P waves) - modeled here as a SMALLER random
//                           jitter band, not a literal beat-grouping
//                           simulation. Flagged as a real simplification, not
//                           silently precise.
//   'irregular'          - genuinely chaotic beat-to-beat variation (AFib,
//                           Torsades) - a LARGER random jitter band.
// `waveform` is a short clinical description surfaced as reference text in
// the console (see console.html's rhythm-notes hint) - it is NOT a claim
// that every device renders this exact morphology; IntelliVue's own local
// ECG-trace engine (see that file's RHYTHM_MAP) renders a real distinct
// shape for whichever of these it has a case for, same "waveform" idea
// expressed as pixels instead of prose.
export const RHYTHM_LIBRARY = {
  'Sinus Rhythm': { defaultRate: 75, regularity: 'regular', waveform: 'Normal P-QRS-T sequence, upright P before every QRS, PR 120-200ms, narrow QRS.' },
  'Sinus Tachycardia': { defaultRate: 120, regularity: 'regular', waveform: 'Normal sinus morphology at a fast rate (>100 bpm); at very fast rates the P wave can merge into the preceding T.' },
  'Sinus Bradycardia': { defaultRate: 45, regularity: 'regular', waveform: 'Normal sinus morphology at a slow rate (<60 bpm); P-QRS-T relationship unchanged.' },
  'Atrial Fibrillation': { defaultRate: 80, regularity: 'irregular', waveform: 'No discrete P waves - fibrillatory baseline; irregularly irregular R-R intervals; narrow QRS unless a pre-existing conduction defect.' },
  'Atrial Flutter': { defaultRate: 150, regularity: 'regular', waveform: 'Sawtooth flutter (F) waves, classically ~300/min atrial rate; ventricular rate set by the conduction ratio (2:1 shown here at ~150 - 4:1 block presenting near 75 is also common).' },
  'Supraventricular Tachycardia': { defaultRate: 180, regularity: 'regular', waveform: 'Narrow-complex, regular, very fast (typically 150-250); P waves often absent or buried in the preceding T wave.' },
  'Junctional Rhythm': { defaultRate: 50, regularity: 'regular', waveform: 'Narrow QRS at an escape rate (40-60); P waves absent, inverted before the QRS, or buried within/just after it (retrograde atrial activation).' },
  'First-Degree AV Block': { defaultRate: 75, regularity: 'regular', waveform: 'Normal P-QRS-T sequence with a fixed, prolonged PR interval (>200ms); every P conducts.' },
  'Second-Degree AV Block (Type I)': { defaultRate: 50, regularity: 'regularly_irregular', waveform: 'Progressively lengthening PR interval until a P wave fails to conduct (dropped QRS), then the pattern repeats (Wenckebach grouping).' },
  'Second-Degree AV Block (Type II)': { defaultRate: 60, regularity: 'regularly_irregular', waveform: 'Fixed PR interval on conducted beats with sudden, unpredictable non-conducted P waves (no progressive lengthening); often a wider QRS than Type I.' },
  'Third-Degree AV Block': { defaultRate: 40, regularity: 'regular', waveform: 'Complete AV dissociation - P waves march through at their own regular rate, independent of a separately regular escape QRS rhythm.' },
  'Idioventricular Rhythm': { defaultRate: 60, regularity: 'regular', waveform: 'Wide QRS, no associated P waves, ventricular escape focus; "accelerated" idioventricular rhythm runs roughly 40-120 (a typical accelerated rate is shown here).' },
  'PEA': { defaultRate: 100, regularity: 'regular', waveform: 'Organized electrical activity (rendered as its underlying morphology) without a palpable pulse - pulselessness is conveyed by flat arterial pressure, not a distinct waveform.' },
  'Ventricular Tachycardia': { defaultRate: 180, regularity: 'regular', waveform: 'Wide, monomorphic QRS complexes at a fast, regular rate; no discrete P waves.' },
  'Torsades de Pointes': { defaultRate: 250, regularity: 'irregular', waveform: 'Polymorphic wide-complex tachycardia with QRS amplitude/axis twisting around the baseline; often precipitated by a prolonged QT.' },
  'Ventricular Fibrillation': { defaultRate: 0, regularity: 'irregular', waveform: 'Chaotic, disorganized fibrillatory baseline with no discrete QRS complexes; no cardiac output.' },
  'Asystole': { defaultRate: 0, regularity: 'regular', waveform: 'No discernible electrical activity - flatline.' },
};

/**
 * Cosmetic, display-only jitter for an irregular rhythm's instantaneous
 * rate. NEVER writes to authored state.hr and NEVER belongs in a sync
 * payload (same "nothing frame/time-relative on the wire" rule as
 * scenarioRunner's activeRamp) - each device re-rolls its own jittered
 * display number independently, every render tick. That's a deliberate
 * design choice, not an oversight: two real monitors sampling the same
 * genuinely irregular rhythm at the same instant frequently do show
 * slightly different instantaneous rates, and it keeps the shared engine's
 * actual state (and every existing replay/sync/test guarantee built on it)
 * exactly as deterministic as it was before this rhythm library existed.
 * `rand` defaults to Math.random but is injectable so this stays a pure,
 * exactly-testable function - tests pass a fixed rand to assert exact
 * bounds instead of a statistical range.
 */
export function jitterHR(baseRate, regularity, rand = Math.random) {
  if (regularity !== 'irregular' && regularity !== 'regularly_irregular') return baseRate;
  if (baseRate <= 0) return baseRate;
  const amplitude = regularity === 'irregular' ? 0.20 : 0.08;
  const delta = (rand() * 2 - 1) * amplitude * baseRate;
  return Math.max(0, Math.round(baseRate + delta));
}

// The real Medtronic 5392's own mode list (devices/pacemaker/...MODE_LIST),
// plus 'off' for "no pacing configured" - the shared engine's own baseline.
// Exported so console.html's new dedicated Pacer panel (Round 3, direct
// request: "pacer adjustments should have own menu in assessments/
// parameters, not just in ACLS/BLS") offers the exact same mode vocabulary
// the real hardware simulator does, rather than a second, divergent list.
export const PACER_MODES = ['off', 'AAI', 'AOO', 'VVI', 'VOO', 'DDD', 'DDI', 'DOO'];
