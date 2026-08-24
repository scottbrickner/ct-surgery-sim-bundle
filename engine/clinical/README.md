# engine/clinical/ — Phases 5-7 (pharmacology, pulsatility, HemoSphere sync)

Every module here is a sibling to `engine/physiology.js` rather than folded
into it, per the audit's own guidance for this whole family: "pulsatility,
CPR, mechanical support, and pharmacology each as their own pure, tested
module exposing read-time overlay functions in the same shape as
`getEffectiveRhythm`/`getEffectiveHR`, composed together at render time."
Pure functions throughout - `state` in, a value out, nothing mutates
authored state except the handful of functions explicitly named for it
(`administerPush`, `setInfusionRate`, `tickCirculation`). Read each module's
own top docblock before extending it; this file is the map, not a
duplicate of the reasoning already written there.

**Composition order matters and is layered, not flat**: `physiology.js`'s
pacer precedence (`getEffectiveHR`) resolves first → `pulsatility.js`'s
perfusion/flow-source model (`getEffectiveMAP`/`CO`/etc) resolves next →
`pharmacology.js`'s `getMedicated*()` wrappers layer medication effects on
top of THAT, gating the drug delta on `isPerfusing()` for the hemodynamic
fields (a vasopressor can't raise a MAP that doesn't exist without flow)
but leaving HR/RR ungated (electrical/respiratory-center drug effects
persist without mechanical flow). Every `getMedicated*()` function is the
one a UI should actually call - never read a raw `state.*` hemodynamic
field directly in a device or the console.

## Files

- **`formulary.js`** — the drug data itself (doses, timing, effect
  magnitudes) and its sourcing. Continuous infusions come from
  `docs/references/CP4-156 Attachment B.pdf` (the same institutional source
  already used for this project's scenario data). IV push drugs (atropine,
  adenosine, metoprolol, amiodarone) are **not** in that source (it's
  continuous-infusion-only) — they're transcribed from the AHA 2025
  Guidelines for CPR and ECC, Part 9 (Adult ALS), per the user's explicit
  confirmation this was the right source before Phase 5 started. Every
  number carries its own `source` citation inline — check there before
  trusting a value, don't assume the whole file was reviewed at the same
  confidence level.
- **`pharmacology.js`** — the pure functions. `administerPush`/
  `canAdministerPush` for IV push drugs (max-dose and repeat-interval
  enforcement); `setInfusionRate`/`getInfusionOnsetMultiplier` for
  continuous infusions; `getMedicationDelta` and the `getMedicated*()`
  wrappers (HR/MAP/SVR/CO/RR) that compose a field's raw/pacer-aware value
  with every active drug's contribution.
- **`pharmacology.test.js`** — 21 tests: per-drug dose/interval/max-dose
  boundaries, the onset→peak→duration curve's exact boundary values, rate
  scaling and onset-window behavior for infusions, an explicit
  `advanceSimClock` (scenarioRunner.js) + `getMedicatedHR` reconciliation
  test proving fast-forwarding simulated time actually moves a drug's
  displayed effect, and the Phase 6/7 composition tests (medication delta
  correctly gated on `isPerfusing()`, `getMedicatedMAP`/`CO` composing on
  the Phase 6/7 base layer instead of raw state).
- **`pulsatility.js`** (Phase 6) — the perfusion/flow-source model.
  `mechanicalActivity(state)` (`'organized'|'fibrillating'|'none'`, derived
  from rhythm + `flags.arrestActive` as a general pulseless override, not
  just for VT); `isNativeFlowPresent`/`isCPRFlowPresent`/
  `isSupportFlowPresent` and the composed `isPerfusing`/`isPulsatile`;
  `tickCirculation` (reactive perfusion-loss/regain bookkeeping, must run
  every tick); `getEffectiveMAP`/`SBP`/`DBP`/`CO`/`SVV`/`PPV`/`ETCO2`/
  `ScvO2` (each field's own docblock explains its specific curve - MAP/SBP/
  DBP/CO scale from a snapshot taken at the instant perfusion was lost;
  SVV/PPV are a simpler binary gate; etCO2/ScvO2 decay toward a floor over
  time). Full design rationale and the six clinically-reviewed judgment
  calls: `pulsatility-design.md` (reviewed and approved 2026-08-24, read it
  before changing the model itself, not just wiring it into a new device).
- **`pulsatility.test.js`** — 39 tests: the full state-matrix (every
  `{rhythm category, CPR, ECMO}` combination from the approved design),
  every `getEffective*()` function's own boundary behavior, and a
  cross-device-consistency test proving `isPerfusing`/`isPulsatile` are
  pure functions of `state` alone - the structural reason two different
  devices reading the same state can never disagree, without either one
  needing its own copy of the logic.

## `state.minute` is now load-bearing

Previously vestigial (BUILD_PROMPT.md/CLAUDE.md both noted "never
auto-incremented by any engine code"). It's now the simulated case clock
every push dose and infusion-rate-change is timestamped against, and the
thing `getPushEffectMultiplier`/`getInfusionOnsetMultiplier` compute
elapsed time from. Two ways it moves:

1. **Ramps still work exactly as before** — a scripted `ramp` step's
   `durationMinutes` still means real wall-clock minutes, unchanged. This
   phase didn't touch that.
2. **`advanceSimClock(runner, minutesToAdvance)`** (new, in
   `engine/scenarioRunner.js`, shared with `stageRunner.js` the same way
   every other generic runner function is) lets a facilitator explicitly
   jump simulated time forward without waiting in real time — the
   "accelerated" side of the phase's "realistic-vs-accelerated response
   timing" goal. Deliberately reuses `applyFacilitatorOverride()` rather
   than duplicating its ramp-rebasing logic; see its own docblock.

Medication effects are **derived at read time** from `state.medications` +
`state.minute` — nothing needs to be "recomputed" when the clock jumps
forward, same "derived overlay, never mutates authored state" rule as
`isPacing()`/`getEffectiveRhythm()`.

## Where this is wired in

- **`facilitator/console.html`** — a new "Medications (IV Push)" section
  under BLS/ACLS (one button per formulary push drug, dose count/total
  shown inline, disabled with the actual guard reason as its tooltip once
  blocked) and a "Simulated Time" section (+1/+5/+15 min). Every drip
  slider now also stamps `medications.infusionSetAtMinute` when its rate
  actually changes (not on every re-render — see
  `stampInfusionOnsetIfRateChanged()`). The live readout's HR/CO/RR/MAP
  rows now show `getMedicated*()` values, not raw ones.
- **`devices/intellivue/IntelliVue_Sim_Monitor.html`** —
  `applyEngineValuesLight` now sets its HR tile from `getMedicatedHR`
  instead of the raw `getEffectiveHR`. One call site, used by every
  local-driving AND remote-sync code path (see the file's own comments on
  why the light-apply split makes this a single fix point).
- **`devices/hemosphere-alta/HemoSphere_Alta_Sim.html`** — HR/MAP/CO/SVV/
  PPV/ScvO2 all go through the `getMedicated*()`/`getEffective*()`
  composition (Phase 5 wired HR/MAP/CO, Phase 7 added SVV/PPV/ScvO2).
  Because this device already derives SVR/CI live from MAP/CVP/CO (a
  pre-existing, documented fidelity choice — see the main README's "known
  deliberate simplifications"), feeding it the composed inputs means
  derived SVR/CI reflect medication AND perfusion effects too, for free,
  with no extra code. Also gained `swanOximetryStatus()` (Phase 7) - fixes
  a real bug where the venous-oximetry status text was hardcoded to
  `drv.mode==="Swan"` regardless of actual sensor/calibration state; now
  reuses `paramAvailable("scvo2")`, the same check that already correctly
  gates the ScvO2 tile itself.

## What each phase deliberately did NOT do

**Phase 5 (pharmacology):**
- **No pharmacokinetic modeling for `insulin`.** Not in CP4-156 (that
  table is vasoactive/continuous-infusion only — a glycemic-control
  insulin protocol is a separate institutional document not present in
  this repo). Flagged explicitly in `formulary.js`, not silently dropped.
- **No IV piggyback or remaining-antiarrhythmic modeling** (vancomycin-style
  `ivpb`, procainamide, sotalol, etc.) — out of scope, not touched.

**Phase 6 (pulsatility):**
- **No rhythm-state-machine integration for adenosine's transient AV
  block.** Its formulary entry carries `effect: { rhythm:
  'transient-av-block' }` as informational/display data only - Phase 6's
  pulsatility model didn't take this on either. Real modeling of "adenosine
  terminates a reentrant SVT" is still a genuine future gap, not silently
  claimed as done by either phase.
- **LVAD/Impella/IABP as distinct mechanical-support flow profiles** - only
  ECMO is modeled (`isSupportFlowPresent`). Each of the other three has a
  materially different flow profile (LVAD: continuous-flow with some
  native pulsatility contribution; Impella: continuous-flow, transvalvular,
  no independent pulsatility; IABP: augments native pulsatility via
  counterpulsation rather than replacing it) and needs its own reasoning
  when that phase happens, not a shared "mechanical support" bucket.
- **Real defibrillation/cardioversion energy mechanics** (joules, pad
  placement, sync-pulse timing) - both actions are facilitator-chosen
  outcomes with no simulated biophysics this pass. Noted future idea:
  tethering to the separate ZOLL R-series simulator project, mirroring how
  the pacemaker already overlays onto this repo's shared sync bus.

**Phase 7 (HemoSphere sync):**
- **No independently-cited ScvO2-during-CPR threshold.** Checked the
  available AHA 2025/STS-2017 reference library; found only jugular venous
  saturation in an unrelated post-arrest neuromonitoring context, not
  central venous saturation during CPR specifically. `getEffectiveScvO2`'s
  CPR-band values are a reasoned-not-cited simplification, flagged plainly
  in its own docblock - revisit if a better reference turns up.

**All phases**: every number in `formulary.js` and `pulsatility.js`'s
CPR/decay constants is a draft pending real clinical review. The audit that
scoped Phase 5/6 was explicit: "every physiologic rule this plan
proposes... will be drafted... but it is a draft until an RN/MD/APP
actually reviews it." Internally consistent and sourced to real published
guidelines (where a citation exists) is not the same as clinically
validated — don't present this as the latter.
