// Phase 5 (Intervention & time-progression engine) formulary data.
//
// A plain JS module exporting an object literal, not a .json file with an
// import-attribute (`with { type: 'json' }`), deliberately - this project's
// zero-build convention needs this to import identically in `node --test`
// and directly in a browser's native ES module loader with no transform
// step, and import-attribute syntax support varies more across Node/browser
// versions than plain ESM does. The content below is otherwise exactly what
// a formulary.json would hold.
//
// SOURCES: continuous infusions (INFUSIONS.*) are transcribed from
// docs/references/CP4-156 Attachment B.pdf ("Intravenous Infusion
// Titration", Keck institutional policy, reviewed 6/23/2022) - already the
// resolved source for this project's scenario data (see CLAUDE.md/
// BUILD_PROMPT.md). Push drugs (PUSH_DRUGS.*) are NOT in CP4-156 (that
// source is continuous-infusion-only) - per the audit's explicit flag and
// the user's confirmed choice, these are transcribed from the AHA 2025
// Guidelines for CPR and ECC, Part 9 (Adult Advanced Life Support),
// Wigginton et al., Circulation. 2025;152(suppl 2):S538-S577,
// doi:10.1161/CIR.0000000000001376 - specifically the "Doses/Details" boxes
// on Figure 6 (Adult Tachyarrhythmia With a Pulse Algorithm, adenosine) and
// Figure 8 (Adult Bradycardia With a Pulse Algorithm, atropine), and Table 2
// (IV Medications Commonly Used for Acute Rate Control in Atrial
// Fibrillation and Atrial Flutter, metoprolol).
//
// onsetMinutes/peakMinutes/durationMinutes for every drug are NOT
// independently cited pharmacokinetic study values - they're a
// training-simplification draft, reasoned from each drug's well-known
// clinical onset/duration class (rapid-onset/short-duration for adenosine,
// minutes-to-peak/hours-duration for a beta-blocker or antiarrhythmic
// bolus, etc.). This whole file is a DRAFT clinical model per the audit's
// own explicit gate ("every physiologic rule... will be drafted... but it
// is a draft until an RN/MD/APP actually reviews it") - needs real
// clinician sign-off before being presented as validated, not just
// internally consistent. See pharmacology.js's own docblock for the
// onset/peak/duration and effect-scaling math this data feeds.
//
// EFFECT MODEL: infusions.*.effectAtMaxRate values are NOT cited
// pharmacodynamic constants - they're a deliberate training simplification:
// the full listed delta applies only once BOTH the infusion is running at
// its formulary maxRate AND enough onsetMinutes have elapsed since the rate
// was last changed; below max rate the delta scales linearly by
// (currentRate/maxRate), and during the onset window it additionally scales
// linearly by (elapsedSinceRateChange/onsetMinutes). This mirrors the SAME
// "derived overlay, never mutates authored state" pattern
// engine/physiology.js already uses for pacer capture
// (isPacing/getEffectiveRhythm/getEffectiveHR) - see pharmacology.js for the
// actual composition. pushDrugs.*.effect deltas apply at full magnitude
// only at peakMinutes, per a rise-then-decay (onset->peak->duration)
// triangular curve - see getPushEffectMultiplier() in pharmacology.js.

export const PUSH_DRUGS = {
  atropine: {
    label: 'Atropine',
    class: 'anticholinergic',
    doseMg: 1,
    repeatIntervalMinutes: 4,
    repeatIntervalRangeMinutes: [3, 5],
    maxTotalDoseMg: 3,
    onsetMinutes: 1,
    peakMinutes: 3,
    durationMinutes: 30,
    effect: { hr: 20 },
    indication: 'Symptomatic bradycardia with cardiopulmonary compromise',
    contraindication: null,
    source: "AHA 2025 CPR/ECC Part 9 (Adult ALS), Figure 8 Doses/Details: 'Atropine IV dose: First dose: 1 mg bolus. Repeat every 3-5 minutes. Maximum total dose: 3 mg.'",
  },
  adenosine: {
    label: 'Adenosine',
    class: 'antiarrhythmic (AV nodal blocker)',
    firstDoseMg: 6,
    secondDoseMg: 12,
    maxDoses: 2,
    onsetMinutes: 0.17,
    peakMinutes: 0.33,
    durationMinutes: 2,
    effect: { rhythm: 'transient-av-block' },
    indication: 'Regular narrow-complex tachycardia; stable regular monomorphic wide-complex tachycardia (diagnostic/therapeutic)',
    contraindication: 'Hemodynamically unstable, irregularly irregular, or polymorphic wide-complex tachycardia (3: Harm per the same guideline)',
    source: "AHA 2025 CPR/ECC Part 9 (Adult ALS), Figure 6 Doses/Details: 'Adenosine IV dose: First dose: 6 mg rapid IV push; follow with NS flush. Second dose: 12 mg if required.'",
  },
  metoprolol: {
    label: 'Metoprolol',
    class: 'beta-adrenergic blocker',
    doseMgMin: 2.5,
    doseMgMax: 5,
    maxDoses: 3,
    onsetMinutes: 2,
    peakMinutes: 10,
    durationMinutes: 240,
    effect: { hr: -20 },
    indication: 'Acute rate control, hemodynamically stable regular narrow-complex tachycardia / atrial fibrillation-flutter with rapid ventricular response',
    contraindication: 'Decompensated heart failure',
    source: "AHA 2025 CPR/ECC Part 9 (Adult ALS), Table 2 (IV Medications Commonly Used for Acute Rate Control in Atrial Fibrillation and Atrial Flutter): 'Metoprolol: 2.5-5 mg over 2 min, up to 3 doses. Avoid in decompensated heart failure.'",
  },
  amiodarone: {
    label: 'Amiodarone',
    class: 'antiarrhythmic (class III)',
    bolusDoseMg: 150,
    bolusDurationMinutes: 10,
    maintenanceMgPerMinFirst: 1,
    maintenanceDurationHoursFirst: 6,
    maintenanceMgPerMinAfter: 0.5,
    onsetMinutes: 5,
    peakMinutes: 15,
    durationMinutes: 360,
    effect: { rhythm: 'antiarrhythmic' },
    indication: 'Recurrent VT; stable wide-complex tachycardia',
    contraindication: null,
    source: "AHA 2025 CPR/ECC Part 9 (Adult ALS), Figure 6 Doses/Details ('Amiodarone IV dose: First dose: 150 mg over 10 minutes. Repeat as needed if VT recurs. Follow by maintenance infusion of 1 mg/min for first 6 hours.') - cross-checked against CP4-156 Attachment B's existing continuous-infusion row for the same drug ('150 mg over 10 mins' bolus, '1 mg/min x 6 hr then 0.5 mg/min' maintenance), which matches exactly.",
  },
};

export const INFUSIONS = {
  epi: {
    label: 'Epinephrine',
    brand: 'Adrenalin',
    concentration: '8 mg/250 mL',
    initialRateMcgPerMin: 1,
    titrationIncrementMcgPerMin: 1,
    maxRateMcgPerMin: 20,
    onsetMinutes: 1,
    effectAtMaxRate: { hr: 25, map: 20 },
    source: "CP4-156 Attachment B, p.2: 'Epinephrine (Adrenalin) - 8 mg/250 mL - 1 mg every 3-5 min as needed [arrest bolus, separate from infusion] - 1 mcg/min, titrate by 1 mcg/min - 20 mcg/min'",
  },
  levo: {
    label: 'Norepinephrine',
    brand: 'Levophed',
    concentration: '8 mg/250 mL',
    initialRateMcgPerMin: 0.5,
    titrationIncrementMcgPerMin: 0.5,
    titrationIntervalMinutes: 4,
    maxRateMcgPerMin: 30,
    onsetMinutes: 2,
    effectAtMaxRate: { map: 35, svr: 500 },
    source: "CP4-156 Attachment B, p.3: 'Norepinephrine (Levophed) - 8 mg/250 mL - 0.5 mcg/min, titrate by 0.5 mcg/min every 3-5 min - 30 mcg/min'",
  },
  milrinone: {
    label: 'Milrinone',
    brand: 'Primacor',
    concentration: '20 mg/100 mL',
    bolusMcgPerKg: 50,
    bolusDurationMinutes: 10,
    initialRateMcgPerKgPerMin: 0.25,
    maxRateMcgPerKgPerMin: 1,
    onsetMinutes: 3,
    effectAtMaxRate: { co: 1.5, svr: -300 },
    source: "CP4-156 Attachment B, p.3: 'Milrinone (Primacor) - 20 mg/100 mL - 50 mcg/kg over 10 min - 0.25 mcg/kg/min - 1 mcg/kg/min' (titration increment not specified in the source - use clinical judgment)",
  },
  propofol: {
    label: 'Propofol',
    brand: 'Diprivan',
    concentration: '1000 mg/100 mL',
    initialRateMcgPerKgPerMin: 5,
    titrationIncrementMcgPerKgPerMin: 5,
    titrationIntervalMinutes: 7.5,
    maxRateMcgPerKgPerMin: 100,
    onsetMinutes: 1,
    effectAtMaxRate: { map: -15, rr: -4 },
    source: "CP4-156 Attachment B, p.3: 'Propofol (Diprivan) - 1000 mg/100 mL - (on ventilator) 5 mcg/kg/min, titrate by 5 mcg/kg/min every 5-10 min - 100 mcg/kg/min'",
  },
  fentanyl: {
    label: 'Fentanyl',
    brand: 'Sublimaze',
    concentration: '1000 mcg/100 mL',
    initialRateMcgPerHr: 25,
    titrationIncrementMcgPerHr: 10,
    titrationIntervalMinutes: 10,
    maxRateMcgPerHr: 150,
    onsetMinutes: 2,
    effectAtMaxRate: { hr: -10, rr: -6 },
    source: "CP4-156 Attachment B, p.2: 'Fentanyl (Sublimaze) - 1000 mcg/100 mL - (on ventilator) 25 mcg/hr, titrate by 10 mcg/hr every 10 min - 150 mcg/hr'",
  },
  vasopressin: {
    label: 'Vasopressin',
    brand: 'Pitressin',
    concentration: '40 units/100 mL',
    initialRateUnitsPerMin: 0.02,
    titrationIncrementUnitsPerMin: 0.01,
    maxRateUnitsPerMin: 0.04,
    onsetMinutes: 3,
    effectAtMaxRate: { map: 25, svr: 400 },
    source: "CP4-156 Attachment B, p.3: 'Vasopressin (Pitressin) - 40 units/100 mL - Shock: 0.02 units/min, titrate by 0.01 units/min - Shock: 0.04 unit/min' (this table's separate 40-unit pulseless VT/VF arrest bolus is not modeled here - out of scope, arrest management is Phase 6/BLS-ACLS territory, not this phase's continuous-infusion formulary)",
  },
  insulin: {
    label: 'Insulin',
    note: "NOT in CP4-156 Attachment B (that source is vasoactive/continuous-infusion titration only - a glycemic-control insulin drip is governed by a separate institutional protocol not present in this repo's docs/references/). Deliberately left out of this phase's dose/onset/duration modeling rather than fabricating institution-specific numbers - stays a raw, unmodeled rate field exactly as it already was. Flagged here, not silently dropped, so a future phase sourcing a real glycemic-control policy knows this is the known gap to fill.",
  },
};
