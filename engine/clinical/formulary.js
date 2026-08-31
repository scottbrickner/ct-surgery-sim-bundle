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

// `category` (added alongside the Round 4 fluids/blood-products/electrolyte
// expansion below) is a pure UI-grouping tag, read only by console.html to
// split ONE formulary into two separate button lists (BLS/ACLS meds vs.
// general Interventions) - it has no effect on dosing/timing/guard logic
// here, which is why it's safe to retrofit onto these four pre-existing
// entries without touching their own tested behavior.
export const PUSH_DRUGS = {
  atropine: {
    label: 'Atropine',
    class: 'anticholinergic',
    category: 'acls',
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
    category: 'acls',
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
    category: 'acls',
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
    category: 'acls',
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

  // Round 4, direct user request: "we need to include more interventions
  // including more meds; fluid boluses blood products albumin;
  // antiarrhythmics; calcium chloride." Neither CP4-156 (IV-infusion-
  // titration only) nor the AHA 2025 ALS guideline (arrest/tachy/brady
  // algorithms only) covers one-time volume/blood-product administration or
  // calcium's routine (non-arrest, non-toxicology) CT-surgery use - every
  // entry below is explicitly flagged for exactly what IS and ISN'T cited,
  // same "draft pending clinician sign-off" gate as the rest of this file.
  // `doseMl`/`doseUnits` (instead of `doseMg`) are new dose-amount fields -
  // see pharmacology.js's administerPush()/getPushTotalDoseAmount() for how
  // the generic dose-tracking machinery resolves whichever one a drug uses.
  // None of these define maxDoses/maxTotalDose*/repeatIntervalRangeMinutes -
  // deliberately unrestricted, consistent with this project's "no limits"
  // decision elsewhere (a facilitator running a massive-transfusion/
  // resuscitation teaching case needs to give many units/boluses back to
  // back, unlike atropine's real hard ACLS ceiling).
  ns_bolus: {
    label: 'NS Bolus (500 mL)',
    class: 'crystalloid fluid bolus',
    category: 'fluid',
    doseMl: 500,
    onsetMinutes: 5,
    peakMinutes: 20,
    durationMinutes: 90,
    effect: { map: 8 },
    indication: 'Suspected hypovolemia; volume-responsive hypotension; resuscitation',
    contraindication: 'Volume overload; decompensated heart failure',
    source: "NOT independently cited from CP4-156 (infusion-titration only, no bolus-fluid dosing) or the AHA ALS guideline (not an ACLS drug). Bolus volume (500 mL) is a standard, widely-used adult crystalloid bolus size; the onset/peak/duration curve is a training SIMPLIFICATION - a real fluid bolus's hemodynamic effect doesn't necessarily fully 'wear off' the way a drug's does (it can also just get redistributed/diuresed), unlike this engine's rise-then-decay-to-zero shape for every push item.",
  },
  lr_bolus: {
    label: "LR Bolus (500 mL)",
    class: 'crystalloid fluid bolus',
    category: 'fluid',
    doseMl: 500,
    onsetMinutes: 5,
    peakMinutes: 20,
    durationMinutes: 90,
    effect: { map: 8 },
    indication: 'Suspected hypovolemia; volume-responsive hypotension; resuscitation - often preferred over NS post-cardiac-surgery to avoid saline-induced hyperchloremic metabolic acidosis',
    contraindication: 'Volume overload; decompensated heart failure',
    source: 'Same sourcing note as NS Bolus above - not independently cited, standard bolus volume, same training-simplification caveat on the decay curve.',
  },
  albumin5: {
    label: 'Albumin 5% (250 mL)',
    class: 'colloid volume expander',
    category: 'fluid',
    doseMl: 250,
    onsetMinutes: 5,
    peakMinutes: 30,
    durationMinutes: 120,
    effect: { map: 6 },
    indication: 'Volume resuscitation, especially with hypoalbuminemia or when a crystalloid-sparing colloid is preferred',
    contraindication: 'Volume overload; decompensated heart failure',
    source: 'NOT independently cited - reasoned from standard clinical use. Isotonic (roughly plasma-equivalent oncotic pressure), so its effect/duration is similar in class to a crystalloid bolus, reasoned slightly longer-lasting than NS/LR per its oncotic (vs purely diffusible) mechanism.',
  },
  albumin25: {
    label: 'Albumin 25% (100 mL)',
    class: 'colloid volume expander (hyperoncotic)',
    category: 'fluid',
    doseMl: 100,
    onsetMinutes: 5,
    peakMinutes: 30,
    durationMinutes: 120,
    effect: { map: 9 },
    indication: 'Hyperoncotic volume expansion (pulls interstitial fluid intravascularly) - often used post-cardiac-surgery to support diuresis or for hypoalbuminemia without a large crystalloid volume load',
    contraindication: 'Volume overload; decompensated heart failure; dehydration (can worsen without adequate free water)',
    source: 'NOT independently cited - reasoned from standard clinical use. A larger per-mL effect than 5% is the entire clinical point of the hyperoncotic (25%) formulation - given as a much smaller volume for a comparable-or-larger intravascular volume shift.',
  },
  prbc: {
    label: 'PRBC (1 unit)',
    class: 'blood product',
    category: 'blood-product',
    doseUnits: 1,
    onsetMinutes: 10,
    peakMinutes: 60,
    durationMinutes: 180,
    effect: { map: 5, co: 0.3 },
    indication: 'Symptomatic anemia; ongoing blood loss; massive transfusion protocol',
    contraindication: null,
    source: "NOT independently cited - this engine has no hemoglobin/hematocrit state field, so PRBC's actual clinical point (restoring oxygen-carrying capacity) genuinely can't be modeled here; the modest MAP/CO bump modeled is only the INCIDENTAL volume effect of a ~300 mL unit, not the transfusion's real benefit. Duration is also a simplification in the other direction - a transfused red cell's real oxygen-carrying benefit persists for WEEKS, far beyond what this engine's rise-then-decay-to-zero push shape could ever represent; the 180-minute duration here describes only the volume effect fading, not the clinical benefit ending.",
  },
  ffp: {
    label: 'FFP (1 unit)',
    class: 'blood product',
    category: 'blood-product',
    doseUnits: 1,
    onsetMinutes: 10,
    peakMinutes: 60,
    durationMinutes: 180,
    effect: { map: 3 },
    indication: 'Coagulopathy / clotting factor replacement; massive transfusion protocol',
    contraindication: null,
    source: "NOT independently cited. Same gap as PRBC above, more so - this engine has no coagulation/INR state at all, so FFP's actual clinical purpose (replacing clotting factors) isn't modeled; only its smaller (~250 mL) incidental volume effect is represented.",
  },
  platelets: {
    label: 'Platelets (1 unit)',
    class: 'blood product',
    category: 'blood-product',
    doseUnits: 1,
    onsetMinutes: 10,
    peakMinutes: 45,
    durationMinutes: 150,
    effect: { map: 2 },
    indication: 'Thrombocytopenia or platelet dysfunction with active/anticipated bleeding; massive transfusion protocol',
    contraindication: null,
    source: 'NOT independently cited. Same gap as FFP - this engine has no platelet-count state, so the actual clinical purpose is not modeled, only a small incidental volume effect.',
  },
  cryo: {
    label: 'Cryoprecipitate (pool of 10)',
    class: 'blood product',
    category: 'blood-product',
    doseUnits: 10,
    onsetMinutes: 10,
    peakMinutes: 45,
    durationMinutes: 150,
    effect: { map: 2 },
    indication: 'Hypofibrinogenemia (e.g. post-bypass, massive transfusion) requiring fibrinogen replacement',
    contraindication: null,
    source: 'NOT independently cited. Modeled as the standard pooled 10-unit dose (how cryoprecipitate is virtually always administered clinically, not as single units). Same gap as the other blood products - no fibrinogen state exists here, only a small incidental volume effect.',
  },
  calcium_chloride: {
    label: 'Calcium Chloride (1 g)',
    class: 'electrolyte / inotrope-adjacent',
    category: 'electrolyte',
    doseMg: 1000,
    onsetMinutes: 1,
    peakMinutes: 5,
    durationMinutes: 20,
    effect: { map: 5, co: 0.3 },
    indication: 'Hypocalcemia (common post-bypass and after large-volume blood-product/citrate administration - see PRBC/FFP/platelets/cryo above), hyperkalemia-associated arrhythmia, calcium-channel-blocker or beta-blocker toxicity',
    contraindication: 'Give via central line where possible - peripheral extravasation is caustic/tissue-damaging',
    source: "The 1 g dose modeled is the standard empiric CT-surgery/ICU dose for hypocalcemia or citrate toxicity - NOT independently cited from either of this project's two canonical sources (CP4-156 doesn't cover it; it's not an arrest drug in the AHA 2025 ALS guideline used for PUSH_DRUGS elsewhere in this file). A real, cited number DOES exist for a related but distinct indication: AHA 2025 CPR/ECC Part 10 (Special Circumstances), Table (Antidotes for Cardiovascular Toxicity), beta-blocker/calcium-channel-blocker poisoning: 'Calcium chloride: 2000 mg (28 mEq Ca2+, 20 mL of 100 mg/mL solution) initial dose, titrate to blood pressure' - a larger, toxicology-specific dose not used here since this entry models the more common routine indication instead. The AHA 2025 ALS guideline (same document PUSH_DRUGS sources atropine/adenosine/metoprolol/amiodarone from) is also explicit that ROUTINE calcium administration during cardiac arrest is NOT recommended (3: No Benefit) - this entry is for hypocalcemia/citrate-toxicity/hyperkalemia/toxicology use, not empiric arrest dosing.",
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

  // Round 4, direct user request: "we need to include more interventions...
  // antiarrhythmics." lidocaine/procainamide close the exact gap this
  // file's own top-level docblock (and console.html's own phase-note) used
  // to flag: "remaining antiarrhythmics are still not modeled." Both ARE in
  // CP4-156 Attachment B - real continuous-infusion antiarrhythmics, not
  // reasoned substitutes. Each drug's own real "convert the rhythm" action
  // is deliberately NOT numerically modeled - same convention amiodarone's
  // PUSH_DRUGS entry already established (`effect:{rhythm:'antiarrhythmic'}`,
  // a descriptive label only; getPushFieldDelta/getInfusionFieldDelta both
  // skip any non-numeric effect value) - a facilitator changes the rhythm
  // dropdown themselves as the chosen outcome, matching this project's
  // established "facilitator-chosen outcome, not simulated conversion
  // logic" pattern (see console.html's shock/cardioversion section). What
  // IS modeled here is each drug's own real, listed adverse effect
  // (hypotension) - the same "model the real numeric side effect even when
  // the headline action isn't simulated" approach propofol/fentanyl already
  // use for sedation's own respiratory/pressure effects.
  lidocaine: {
    label: 'Lidocaine',
    brand: 'Xylocaine',
    concentration: '2 gm/500 mL',
    class: 'antiarrhythmic (class Ib)',
    initialRateMgPerMin: 1,
    titrationIncrementMgPerMin: 1,
    maxRateMgPerMin: 4,
    onsetMinutes: 2,
    effectAtMaxRate: { map: -5 },
    source: "CP4-156 Attachment B, p.2: 'Lidocaine (Xylocaine) - 2 gm/500 mL - 1-1.5 mg/kg over 2-3 min [bolus, requires prescriber order - not separately simulated, same as milrinone's/amiodarone's own documented-but-unsimulated bolus fields] - 1 mg/min - 4 mg/min'. Hypotension (the modeled effect) is the source's own listed adverse effect for this drug.",
  },
  procainamide: {
    label: 'Procainamide',
    brand: 'Pronestyl',
    concentration: '2 gm/250 mL',
    class: 'antiarrhythmic (class Ia)',
    initialRateMgPerMin: 1,
    titrationIncrementMgPerMin: 1,
    maxRateMgPerMin: 6,
    onsetMinutes: 5,
    effectAtMaxRate: { map: -6 },
    source: "CP4-156 Attachment B, p.3: 'Procainamide (Pronestyl) - 2 gm/250 mL - 1 gm over 1 hr [bolus, requires prescriber order - not separately simulated] - 1 mg/min - 6 mg/min (monitor levels)'. Hypotension (the modeled effect) is the source's own listed adverse effect for this drug.",
  },

  // Direct user request: "inhaled nitric oxide/inhaled epoprostonolol."
  // Neither is an IV infusion (both are ventilator-circuit-delivered
  // inhaled pulmonary vasodilators, dosed in ppm / mcg-per-kg-per-min
  // respectively) so neither appears in CP4-156 (IV-infusion-titration
  // only) or the AHA ALS guideline (not ACLS drugs) - dosing reasoned from
  // standard critical-care practice for RV failure/pulmonary hypertension,
  // NOT independently cited from either of this project's two canonical
  // sources. Modeled with a real, clinically load-bearing effect on PA
  // pressures specifically (see pharmacology.js's new getMedicatedPASys/
  // getMedicatedPADia) and DELIBERATELY no systemic MAP effect at all -
  // that selective pulmonary-only action (unlike an IV pulmonary
  // vasodilator, which would drop systemic pressure too) is the entire
  // clinical reason these inhaled forms exist, and is itself a real
  // teaching point this simulator can now demonstrate.
  inhaledNO: {
    label: 'Inhaled Nitric Oxide',
    brand: 'INOmax',
    concentration: 'delivered via ventilator circuit (ppm)',
    initialRateAsPpm: 20,
    titrationIncrementPpm: 5,
    titrationIntervalMinutes: 15,
    maxRatePpm: 40,
    onsetMinutes: 2,
    effectAtMaxRate: { paSys: -12, paDia: -6 },
    source: 'NOT independently cited from CP4-156 or the AHA ALS guideline. Typical starting dose (20 ppm) and usual range (5-40 ppm, rarely to 80) reasoned from standard critical-care practice for RV failure/pulmonary hypertension after cardiac surgery.',
  },
  epoprostenol: {
    label: 'Inhaled Epoprostenol',
    brand: 'Flolan (inhaled)',
    concentration: 'delivered via ventilator circuit (mcg/kg/min via nebulizer)',
    initialRateMcgPerKgPerMin: 0.025,
    titrationIncrementMcgPerKgPerMin: 0.025,
    titrationIntervalMinutes: 15,
    maxRateMcgPerKgPerMin: 0.05,
    onsetMinutes: 5,
    effectAtMaxRate: { paSys: -10, paDia: -5 },
    source: 'NOT independently cited from CP4-156 or the AHA ALS guideline. Typical dose range (25-50 ng/kg/min, i.e. 0.025-0.05 mcg/kg/min) reasoned from standard critical-care practice for RV failure/pulmonary hypertension - the same indication as inhaled nitric oxide above, an alternative/adjunct agent.',
  },
};
