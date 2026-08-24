# Clinical Model — Sources, Assumptions & Sign-Off Checklist

**Training simulation only. Not for clinical use.** This document describes how the Clinical Patient Simulator's physiology/pharmacology engine behaves — every rule it applies, where each number came from, and exactly which parts are cited against a published source versus reasoned as an internally-consistent training simplification. It exists so a clinician (RN/MD/APP) can review and sign off on the model before it's presented to learners as realistic, per the original repository audit's own explicit gate:

> "Every physiologic rule this plan proposes... will be drafted from the evidence sources already available and cited explicitly, but it is a **draft** until an RN/MD/APP actually reviews it."

Nothing below has had that review yet. Internally consistent and sourced to real published guidelines (where a citation exists) is **not** the same as clinically validated — this document draws that line explicitly, section by section, rather than presenting a uniform appearance of authority.

**How to read this document**: every rule is tagged one of three ways —

- 🟢 **CITED** — taken directly from a specific page/figure/table of a named, dated source. The exact quoted or paraphrased text is given.
- 🟡 **REASONED** — an internally consistent training simplification, not taken from a specific published number. Flagged as such in the code itself, not silently presented as sourced.
- 🔴 **NOT MODELED** — explicitly out of scope; the engine does not simulate this at all. Listed so a reviewer knows to look for it, not assume its absence is an oversight.

Every number in the running engine ultimately lives in one of two source files: `engine/clinical/formulary.js` (pharmacology) and `engine/clinical/pulsatility.js` (perfusion/CPR/mechanical support). Both carry the same citations inline in code comments — this document is the consolidated, clinician-facing view of that same data, not a second, divergent copy. If the two ever disagree, the code is the source of truth and this document has drifted; report that as a documentation bug.

---

## 1. Perfusion, pulsatility & mechanical support

**Design review status**: 🟢 Reviewed and approved by the user (a clinician) on 2026-08-24 before any implementation was written — see `engine/clinical/pulsatility-design.md` for the full reasoning trail, including what was originally proposed versus what the reviewing clinician actually corrected. This section summarizes the *result*; that file is the record of *how* it was reached.

### 1.1 Four distinct concepts, not one conflated "rhythm" field

The engine deliberately separates four questions that a single `rhythm` string used to conflate:

| Concept | Question it answers | Field |
|---|---|---|
| Electrical rhythm | What does the ECG show? | `state.rhythm` |
| Mechanical activity | Is the heart's muscle actually contracting in useful coordination with that electricity? | `mechanicalActivity(state)` → `organized` \| `fibrillating` \| `none` |
| Flow sources | What's actually moving blood right now? | native / CPR / mechanical support — independent of each other |
| Perfusion vs. pulsatility | Is tissue perfused at all? Separately, is that flow pulsatile? | two independent booleans |

This is what makes PEA (organized-looking ECG, no pulse), pulseless VT, and nonpulsatile-but-adequately-perfused ECMO all representable correctly — none of which a single rhythm-string model could distinguish.

🟡 **REASONED**: `flags.arrestActive` is the general "this rhythm, whatever it is, currently has no effective pulse" override — reviewed and deliberately generalized beyond ventricular tachycardia during the design pass. The reviewing clinician's own example: cardiac tamponade presenting in **Sinus Rhythm but pulseless** — an organized-looking ECG with zero effective mechanical activity, clinically identical to PEA despite the rhythm label.

### 1.2 Flow sources

- **Native flow** — present iff mechanical activity is `organized`.
- **CPR flow** — present iff `state.circulation.cpr.active`, independent of rhythm (CPR can technically be "performed" during any rhythm; the engine doesn't assume it's only used correctly).
- **Mechanical-support flow** — present iff `flags.ecmoCannulated`. 🔴 **NOT MODELED**: LVAD, Impella, and IABP are each a materially different flow profile from ECMO (LVAD: continuous-flow with some native pulsatility contribution; Impella: continuous-flow, transvalvular, no independent pulsatility; IABP: augments native pulsatility via counterpulsation rather than replacing it) and are explicitly deferred, each needing its own reasoning rather than being approximated as "ECMO but weaker."

### 1.3 Perfusion and pulsatility

```
perfusing = native flow OR CPR flow OR support flow
pulsatile = native flow OR CPR flow          (support flow alone is NOT pulsatile)
```

A nonpulsatile-but-ECMO-perfused patient never renders as arrest; their arterial line renders flat-but-elevated rather than a normal pulsatile trace or a true flatline.

### 1.4 CPR quality → hemodynamics

Two discrete tiers only: **good** or **poor** — not a continuous quality scale.

🟢 **CITED threshold** (etCO₂ during CPR) — AHA 2025 Guidelines for CPR and ECC, Part 9 (Adult Advanced Life Support), Wigginton et al., *Circulation.* 2025;152(suppl 2):S538–S577, doi:10.1161/CIR.0000000000001376:

> "An ETCO2 less than 10 mm Hg is generally associated with poor outcomes, whereas values above 10 mm Hg, and ideally above 20 mm Hg, are associated with increased rates of ROSC... targeting compressions to a value of at least 10 mm Hg, and ideally 20 mm Hg or greater, may indicate mechanically adequate technique."

(The same source also notes failure to reach >10 mmHg after 20 minutes of ALS may factor into a termination-of-resuscitation decision — **not modeled**, noted for reviewer awareness only.)

| Field | Good CPR | Poor CPR | Status |
|---|---|---|---|
| etCO₂ | 18 mmHg (representative, within the cited ">10, ideally >20" band) | 6 mmHg (representative, within the cited "≤10" band) | 🟢 threshold cited / 🟡 exact representative value reasoned |
| MAP | 45% of pre-arrest baseline | 20% of pre-arrest baseline | 🟡 REASONED (midpoints of a 40–50% / 15–25% band, not independently cited) |
| CO | 1.5 L/min (fixed representative value, not scaled from baseline) | 0.6 L/min | 🟡 REASONED |
| ScvO₂ | 45% | 25% | 🟡 REASONED |
| SVV / PPV | passes through the authored value unchanged (binary gate: any real flow = meaningful, no flow = 0) | same | 🟡 REASONED simplification (SVV/PPV are only clinically interpretable with a real arterial waveform, so a binary rather than scaled rule was chosen) |

MAP/SBP/DBP/CO during CPR scale from a value **snapshotted at the instant perfusion was lost**, not the live authored value (which a scripted arrest event may have since zeroed) — this avoids CPR effectively "reviving" a patient to a baseline that was never actually theirs during the arrest.

### 1.5 No flow at all (true arrest, no CPR, no support)

- MAP/SBP/DBP → 0.
- CO → exactly 0 (no snapshot/decay needed — CO genuinely is zero with nothing moving blood).
- etCO₂ → decays linearly toward a **4 mmHg floor over ~1 minute** of unaddressed arrest. 🟡 REASONED (the floor value and decay rate are not independently cited; the *clinical premise* — that a stale pre-arrest capnogram plateau is wrong and etCO₂ should fall when nothing is moving blood — is standard capnography physiology, not itself in question).
- ScvO₂ → decays toward a **15% floor over ~2 minutes**. 🟡 REASONED, explicitly **not independently cited** — the available AHA 2025 / STS-2017 reference library was checked and yielded only jugular venous saturation in an unrelated post-arrest neuromonitoring context, not central venous saturation during CPR specifically. Flagged plainly in code rather than presented as sourced.

### 1.6 ECMO and etCO₂ — a deliberate non-special-case

🟢 **REVIEWED AND CONFIRMED WITH THE CLINICIAN**: etCO₂ during ECMO-only perfusion (no CPR, no native flow) behaves exactly like any other perfusing-without-CPR state — the authored value passes through unchanged. No ECMO-specific etCO₂ physiology is modeled. A facilitator can always manually override etCO₂ for a specific ECMO teaching scenario via the existing override-release control — no separate mechanism was judged necessary.

### 1.7 ROSC, defibrillation & cardioversion

🟢 **REVIEWED AND CONFIRMED WITH THE CLINICIAN**: ROSC is deliberately *not* a new tracked state machine — it composes two existing primitives (an instant rhythm/flag change, plus an optional ramp toward a stable post-ROSC baseline over a facilitator-set number of minutes, representing the commonly-taught post-ROSC hemodynamic instability window).

"Deliver Shock" and "Synchronized Cardioversion" are two **facilitator/learner-chosen-outcome** actions — the facilitator/learner decides whether the shock converts the rhythm; there is no simulated defibrillation biophysics. 🔴 **NOT MODELED**: energy/joules selection, pad placement, and actual synchronized-pulse timing mechanics. Noted as a real future idea (not committed to any phase): tethering to the separate ZOLL R-series defibrillator simulator project, using the same overlay-contributor sync pattern the Medtronic pacemaker already uses in this repository.

---

## 2. Pharmacology

**Sourcing, confirmed with the user before Phase 5 began**: continuous infusions come from an existing, already-resolved institutional source (below); the four IV push drugs are not covered by that source and were sourced from AHA guidelines instead, per the user's explicit confirmation this was the right substitute.

### 2.1 IV push drugs

🟢 **CITED** — AHA 2025 Guidelines for CPR and ECC, Part 9 (Adult Advanced Life Support), Wigginton et al., *Circulation.* 2025;152(suppl 2):S538–S577, doi:10.1161/CIR.0000000000001376. Specific figures/tables cited per drug below.

| Drug | Dose | Max / repeat | Source figure | Quoted text |
|---|---|---|---|---|
| Atropine | 1 mg bolus | Repeat q3–5 min, max 3 mg total | Figure 8 (Adult Bradycardia With a Pulse Algorithm), Doses/Details | "First dose: 1 mg bolus. Repeat every 3-5 minutes. Maximum total dose: 3 mg." |
| Adenosine | 6 mg first dose, 12 mg second | Max 2 doses | Figure 6 (Adult Tachyarrhythmia With a Pulse Algorithm), Doses/Details | "First dose: 6 mg rapid IV push; follow with NS flush. Second dose: 12 mg if required." |
| Metoprolol | 2.5–5 mg over 2 min | Up to 3 doses | Table 2 (IV Medications for Acute Rate Control in AF/AFlutter) | "2.5-5 mg over 2 min, up to 3 doses. Avoid in decompensated heart failure." |
| Amiodarone | 150 mg over 10 min bolus | Repeat as needed for recurrent VT; maintenance 1 mg/min × 6 hr then 0.5 mg/min | Figure 6, Doses/Details | "First dose: 150 mg over 10 minutes... Follow by maintenance infusion of 1 mg/min for first 6 hours." Cross-checked against CP4-156 Attachment B's own amiodarone row (below) — the two sources match exactly. |

🟡 **REASONED**, all four drugs: onset/peak/duration-of-effect timing (e.g. adenosine's ~10-second onset, atropine's 30-minute effect duration) and the exact HR/rhythm-effect magnitude used for display are **not** independently cited pharmacokinetic study values — they're reasoned from each drug's well-known clinical onset/duration class (e.g. rapid-onset/short-duration for adenosine vs. minutes-to-peak/hours-duration for a beta-blocker bolus), a training simplification, not a PK/PD citation.

🔴 **NOT MODELED**: adenosine's transient AV-block effect on the ECG rhythm itself — its formulary entry carries this as informational/display metadata only; the engine does not actually alter rhythm/conduction. Real modeling of "adenosine terminates a reentrant SVT" is a genuine future gap.

### 2.2 Continuous infusions

🟢 **CITED** — `docs/references/CP4-156 Attachment B.pdf`, "Intravenous Infusion Titration," Keck institutional policy, reviewed 6/23/2022.

| Drug | Concentration | Start / titrate | Max | Effect at max rate (display only) |
|---|---|---|---|---|
| Epinephrine (Adrenalin) | 8 mg/250 mL | 1 mcg/min, titrate by 1 | 20 mcg/min | HR +25, MAP +20 |
| Norepinephrine (Levophed) | 8 mg/250 mL | 0.5 mcg/min, titrate by 0.5 q3–5min | 30 mcg/min | MAP +35, SVR +500 |
| Milrinone (Primacor) | 20 mg/100 mL | Bolus 50 mcg/kg/10min, then 0.25 mcg/kg/min | 1 mcg/kg/min | CO +1.5, SVR −300 |
| Propofol (Diprivan) | 1000 mg/100 mL | 5 mcg/kg/min, titrate by 5 q5–10min | 100 mcg/kg/min | MAP −15, RR −4 |
| Fentanyl (Sublimaze) | 1000 mcg/100 mL | 25 mcg/hr, titrate by 10 q10min | 150 mcg/hr | HR −10, RR −6 |
| Vasopressin (Pitressin) | 40 units/100 mL | 0.02 units/min, titrate by 0.01 | 0.04 units/min | MAP +25, SVR +400 |

Milrinone's titration increment is not specified in the source ("use clinical judgment" per the source document itself). Vasopressin's separate 40-unit pulseless-arrest bolus (distinct from the continuous infusion above) is 🔴 **NOT MODELED** — out of this formulary's scope.

🟡 **REASONED**: the "effect at max rate" deltas above are a deliberate training simplification, not cited pharmacodynamic constants. The full delta applies only once BOTH the infusion is running at its formulary max rate AND enough onset time has elapsed since the rate was last changed; below max rate it scales linearly by (current rate / max rate).

🔴 **NOT MODELED**: **insulin** — not present in CP4-156 (that source is vasoactive/continuous-infusion titration only; a glycemic-control protocol is a separate institutional document not present in this repository). Left as a raw, unmodeled rate field rather than fabricating institution-specific numbers. IV piggybacks and remaining antiarrhythmics (e.g. procainamide, sotalol) are also not modeled.

---

## 3. Composition rules (how these layers combine)

1. Pacer capture precedence resolves first (a captured, non-demand-inhibited pacer's rate/rhythm overrides the intrinsic value for display).
2. The perfusion/flow-source model (Section 1) resolves next.
3. Medication effects (Section 2) layer on top of that — **gated on active perfusion for hemodynamic fields** (a vasopressor cannot raise a MAP that doesn't exist without flow), but **HR and RR effects are never gated** — a chronotropic drug's effect on the SA node, or a sedative's effect on the respiratory center, are both real even without mechanical flow (e.g. PEA's electrical rate still responds to atropine; fentanyl still depresses respiration during CPR).

---

## 4. Clinician sign-off checklist

Each row is one reviewable claim. Check off only what has actually been reviewed against real clinical knowledge/current guidelines — an unchecked row is not a defect, it's an honest "not yet reviewed."

### Perfusion / pulsatility / CPR / mechanical support
- [ ] Mechanical-activity classification (organized / fibrillating / none) correctly represents real clinical states, including `arrestActive` as a general pulseless override for any rhythm.
- [ ] Flow-source independence (native / CPR / support) matches real physiology.
- [ ] Perfusing-vs-pulsatile distinction (support flow alone ≠ pulsatile) is accurate.
- [ ] CPR good/poor MAP fractions (45% / 20% of pre-arrest baseline) are clinically reasonable representative values.
- [ ] CPR good/poor CO values (1.5 / 0.6 L/min) are clinically reasonable representative values.
- [ ] CPR good/poor ScvO₂ values (45% / 25%) are clinically reasonable, given no independent citation was found for this specific value.
- [ ] etCO₂ floor (4 mmHg) and decay window (~1 min) after unaddressed arrest are clinically reasonable.
- [ ] ScvO₂ floor (15%) and decay window (~2 min) after unaddressed arrest are clinically reasonable.
- [ ] ECMO's "no etCO₂ special-case" decision (Section 1.6) is acceptable for training purposes.
- [ ] ROSC-as-thin-helper (instant conversion + optional post-ROSC instability ramp) adequately represents the real event for training purposes.
- [ ] Deferring LVAD/Impella/IABP (Section 1.2) and real defibrillation energy mechanics (Section 1.7) is an acceptable scope boundary for this version.

### Pharmacology
- [ ] Atropine dose/max/indication (Section 2.1) is accurate and current.
- [ ] Adenosine dose/max/contraindication (Section 2.1) is accurate and current.
- [ ] Metoprolol dose/max/contraindication (Section 2.1) is accurate and current.
- [ ] Amiodarone bolus/maintenance dosing (Section 2.1) is accurate and current.
- [ ] Continuous-infusion start/titrate/max rates (Section 2.2) still match current institutional policy (CP4-156 Attachment B was last reviewed 6/23/2022 — confirm it hasn't since been superseded).
- [ ] The reasoned (not cited) onset/peak/duration timing values across all drugs (Section 2.1–2.2) are clinically reasonable training approximations.
- [ ] The reasoned "effect at max rate" display deltas (Section 2.2) are clinically reasonable training approximations, understood as simplified/non-linear-PK-accurate by design.
- [ ] Leaving insulin, IV piggybacks, and remaining antiarrhythmics unmodeled (Section 2.2) is an acceptable scope boundary for this version.

### Composition
- [ ] The HR/RR-ungated-but-hemodynamics-gated-on-perfusion composition rule (Section 3) matches real clinical teaching.

**Reviewer**: _______________________  **Credentials**: _______________________  **Date**: _______________________

**Overall disposition** (circle one): Approved as-is · Approved with the noted corrections below · Not yet ready for learner use

**Corrections / notes**:

```




```

---

## 5. References

1. Wigginton JG, et al. 2025 American Heart Association Guidelines for Cardiopulmonary Resuscitation and Emergency Cardiovascular Care, Part 9: Adult Advanced Life Support. *Circulation.* 2025;152(suppl 2):S538–S577. doi:10.1161/CIR.0000000000001376. (`docs/references/G01_AHA-2025_CPR-ECC-Part-09-Adult-ALS.pdf`, if present locally — not committed to this public repository; consult the published guideline directly.)
2. Keck Medicine of USC, CP4-156 Attachment B, "Intravenous Infusion Titration" (institutional policy, reviewed 6/23/2022). `docs/references/CP4-156 Attachment B.pdf` — gitignored, present on the build machine's local disk only, not committed to this public repository (internal institutional document).

---

*Training simulation only. Not for clinical use. This document and the engine it describes are a training aid for CT-surgery-focused nursing education and have not been validated against a live patient monitoring system or a clinical decision-support standard of any kind.*
