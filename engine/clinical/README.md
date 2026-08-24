# engine/clinical/ — Phase 5 (Intervention & time-progression engine)

Formulary-driven medication engine, sibling to `engine/physiology.js` rather
than folded into it, per the audit's own guidance for this whole family of
future clinical modules ("pulsatility, CPR, mechanical support, and
pharmacology each as their own pure, tested module exposing read-time
overlay functions in the same shape as `getEffectiveRhythm`/`getEffectiveHR`,
composed together at render time"). Read `pharmacology.js`'s own docblock
before extending this - the two effect curves (push-drug rise-then-decay vs.
infusion rate-scaled-hold) and the composition order (pacer precedence
resolved first, medication delta layered on top) are both explained there in
full, not repeated here.

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
- **`pharmacology.test.js`** — 16 tests: per-drug dose/interval/max-dose
  boundaries, the onset→peak→duration curve's exact boundary values, rate
  scaling and onset-window behavior for infusions, and an explicit
  `advanceSimClock` (scenarioRunner.js) + `getMedicatedHR` reconciliation
  test proving fast-forwarding simulated time actually moves a drug's
  displayed effect, not just the clock display — the acceptance criterion
  the audit named directly.

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
- **`devices/hemosphere-alta/HemoSphere_Alta_Sim.html`** — same pattern for
  HR, MAP, and CO. Because this device already derives SVR/CI live from
  MAP/CVP/CO (a pre-existing, documented fidelity choice — see the main
  README's "known deliberate simplifications"), feeding it medicated
  MAP/CO inputs means the derived SVR/CI now reflect medication effects
  too, for free, with no extra code.

## What this phase deliberately did NOT do

- **No pharmacokinetic modeling for `insulin`.** Not in CP4-156 (that
  table is vasoactive/continuous-infusion only — a glycemic-control
  insulin protocol is a separate institutional document not present in
  this repo). Flagged explicitly in `formulary.js`, not silently dropped.
- **No rhythm-state-machine integration for adenosine's transient AV
  block.** Its formulary entry carries `effect: { rhythm:
  'transient-av-block' }` as informational/display data only — actually
  modeling "adenosine terminates a reentrant SVT" needs real rhythm-engine
  work that belongs to Phase 6 (Philips physiological realism & BLS/ACLS),
  not this phase.
- **No IV piggyback or remaining-antiarrhythmic modeling** (vancomycin-style
  `ivpb`, procainamide, sotalol, etc.) — out of scope, not touched.
- **Every number in `formulary.js` is a draft pending real clinical
  review.** The audit that scoped this phase was explicit: "every
  physiologic rule this plan proposes... will be drafted... but it is a
  draft until an RN/MD/APP actually reviews it." Internally consistent and
  sourced to real published guidelines is not the same as clinically
  validated — don't present this as the latter.
