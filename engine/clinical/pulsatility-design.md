# Phase 6 design: pulsatility, CPR, mechanical support & perfusion

**Status: REVIEWED AND APPROVED — 2026-08-24.** All six open questions below resolved with the user directly (a clinician). Implementation proceeds against this version. Kept the REVIEW markers and the original proposals in place, with **RESOLVED** notes appended, so the reasoning trail stays visible rather than silently rewriting history.

## The problem this solves

Today, `state.rhythm` is doing double duty: it's the ECG label AND (implicitly, via a couple of scattered checks) the thing that decides whether the patient has a pulse. That conflation is exactly where it breaks:

- **PEA** (pulseless electrical activity) is *organized-looking* electricity with *no* pulse, by definition. IntelliVue's current `perfusing()` only excludes `vfib`/`asystole` — it treats PEA as perfusing, which is backwards.
- **Pulseless VT** and **VT-with-a-pulse** are the *same* rhythm string with opposite clinical outcomes. The engine has no way to tell them apart today.
- **ECMO** can maintain adequate perfusion with *almost no pulsatility at all*, even during VF or asystole. That's the whole point of ECMO in refractory arrest. Today `flags.ecmoCannulated` is a bare boolean with zero effect on anything.
- **CPR** doesn't exist as a concept anywhere in the engine.
- **etCO₂** isn't even in the shared engine's state — it's a device-local-only field on IntelliVue, untouched by arrest events. Confirmed gap: firing "Arrest" zeroes BP/rhythm but the capnogram keeps a normal pre-arrest plateau until a facilitator manually zeroes RR.

## Four concepts, kept distinct on purpose

| Concept | What it answers | Where it lives |
|---|---|---|
| **Electrical rhythm** | What does the ECG show? | `state.rhythm` (unchanged, existing field) |
| **Mechanical activity** | Is the heart's muscle actually contracting in useful coordination with that electricity? | **new, derived** — `organized` \| `fibrillating` \| `none` |
| **Flow sources** | What's actually moving blood right now — the heart itself, chest compressions, or a pump? | **new** — native / CPR / mechanical-support, each can be present independently |
| **Perfusion vs. pulsatility** | Is tissue being perfused at all? Separately: is that flow *pulsatile* (a palpable pulse) or *continuous* (ECMO full support)? | **new, derived** — two separate booleans, not one |

### Mechanical activity — derived from rhythm + one existing flag

```
mechanicalActivity(state):
  if rhythm === 'Ventricular Fibrillation'        → 'fibrillating'
  else if rhythm === 'PEA'                        → 'none'
  else if flags.arrestActive === true              → 'none'   ← the general override
  else                                              → 'organized'
```

**REVIEW #1 — RESOLVED, approved as proposed, generalized beyond VT.** `flags.arrestActive` is the mechanical-activity override for any rhythm that doesn't already imply pulselessness on its own. This isn't just a pulseless-VT case: the user's own clinical example is **cardiac tamponade presenting in Sinus Rhythm but pulseless** — an organized-looking ECG rhythm with zero effective mechanical activity, requiring CPR, exactly like PEA clinically even though the rhythm string says "sinus." The doc's earlier framing ("this is specifically how pulseless VT gets represented") undersold this — `arrestActive` is the general "this rhythm, whatever it is, currently has no effective pulse" signal, and the `mechanicalActivity()` derivation already handles it correctly for any rhythm, not just VT. No new flag needed.

**LVAD**: confirmed deferred. **Note for a future phase**: also need Impella and IABP eventually, not just LVAD — three distinct mechanical-support flow profiles (LVAD: continuous-flow, still some native pulsatility contribution; Impella: continuous-flow, transvalvular, no independent pulsatility; IABP: augments native pulsatility rather than replacing it, counterpulsation timed to the cardiac cycle) — none of the three should be modeled as "ECMO but weaker," each needs its own flow-profile reasoning when that phase happens.

### Flow sources — three independent yes/no questions

- **Native flow**: present iff `mechanicalActivity === 'organized'`.
- **CPR flow**: present iff compressions are currently active (new `state.circulation.cpr.active`) — **independent of rhythm**. You can do CPR on someone in sinus rhythm (wrong, but the engine shouldn't assume otherwise) or during VF/PEA/asystole (the actual point of CPR).
- **Mechanical-support flow**: present iff `flags.ecmoCannulated === true`. **This pass models ECMO only** — LVAD is a materially different flow profile (partial pulsatility, native heart still contributing) and I'm proposing to defer it rather than approximate it into the ECMO model. Flagged explicitly, not silently folded in.

### Perfusion and pulsatility — two different booleans

```
perfusing   = nativeFlow || cprFlow || supportFlow
pulsatile   = nativeFlow || cprFlow          ← support flow alone is NOT pulsatile
```

This is the exact distinction the acceptance criteria are built around: a nonpulsatile-but-ECMO-perfused patient must never render as arrest (`perfusing === true`), but their ART line should render flat-ish/dampened rather than a normal pulsatile trace (`pulsatile === false`).

## CPR quality → effective MAP / etCO₂

**REVIEW #2 — RESOLVED, approved as proposed.** `state.circulation.cpr = { active: boolean, quality: 'good' | 'poor' | null }`, two discrete tiers.

**REVIEW #3 — RESOLVED, real citation found and used.** `G01_AHA-2025_CPR-ECC-Part-09-Adult-ALS.pdf` (its algorithm-box/recommendation text, not an image this time — directly extractable): *"An ETCO2 less than 10 mm Hg is generally associated with poor outcomes, whereas values above 10 mm Hg, and ideally above 20 mm Hg, are associated with increased rates of ROSC... targeting compressions to a value of at least 10 mm Hg, and ideally 20 mm Hg or greater, may indicate mechanically adequate technique."* (Also separately: failure to reach >10 mmHg after 20 min of ALS may factor into a termination-of-resuscitation decision — not modeled this pass, noted for awareness.)

Final tiering, using the cited threshold (user confirmed >10 over their own initial >12 estimate, once the exact guideline number was found):

- **Good** compressions → etCO₂ > 10 mmHg (up to ~20+ as "ideal," per the citation); effective MAP ≈ 40–50% of the patient's pre-arrest baseline.
- **Poor** compressions → etCO₂ ≤ 10 mmHg; effective MAP ≈ 15–25% of baseline.

## etCO₂ becomes a real shared-engine field

Currently only exists as an IntelliVue-local value, never touched by the shared engine. Proposing to add `etco2` to `engine/physiology.js`'s `BASE_STATE` (a real authored vital, same tier as `rr`/`spo2`/`temp`) and a new `getEffectiveETCO2(state)` overlay:

- Perfusing via native flow → authored `state.etco2` passes through unchanged (today's behavior, now actually reachable).
- Perfusing via CPR only → scaled per the quality tiers above.
- Perfusing via support flow only (ECMO, no CPR, no native) → **REVIEW #4 — RESOLVED: no ECMO special-case at all.** etCO₂ behaves exactly the same as native perfusion (authored value passes through unchanged) regardless of ECMO - not a distinct branch, just the same "perfusing without CPR" path every other perfusing state uses. A facilitator can always manually override etco2 for a specific ECMO scenario via the existing override-release primitive (same mechanism as every other numeric field) - no new mechanism needed for that case.
- Not perfusing at all → decays toward ~3–5 mmHg over a short window after perfusion is lost, tracked via a new `circulation.lastPerfusingAtMinute` timestamp (same `state.minute`-based pattern Phase 5 already established for medication onset) — this is what closes the confirmed gap (capnogram no longer holds a stale pre-arrest plateau).

## ROSC — proposing this is NOT a new state machine object

**REVIEW #5 — RESOLVED, thin helper confirmed, no new tracked state.** `achieveROSC(runner, nowMs, { unstableForMinutes })` built entirely from existing primitives:

1. Sets rhythm to an organized value + `flags.arrestActive: false` (instant).
2. Optionally starts a ramp (`startFacilitatorRamp`, already exists) toward a stable post-ROSC baseline over `unstableForMinutes`, representing the real, commonly-taught post-ROSC hemodynamic instability window rather than snapping straight back to pre-arrest vitals.

## Defibrillation / cardioversion — scoped small, two actions not one

**REVIEW #6 — RESOLVED.** Two simple facilitator/learner actions this pass, both a chosen-outcome shock with no energy mechanics:

- **"Deliver Shock" (defibrillation)** — for `fibrillating`/`none` mechanical activity (VF, PEA, pulseless VT/asystole-equivalent). Converts or doesn't, facilitator/learner-chosen outcome, feeds into `achieveROSC()` on success.
- **"Synchronized Cardioversion"** — a *separate* action for an organized-but-unstable tachyarrhythmia (unstable AFib/RVR, unstable SVT, VT-with-a-pulse) converting to a stable organized rhythm. Distinct clinically (synchronized to the R-wave, used when there IS a pulse) and distinct in this model (mechanical activity is already `organized` going in - this changes the rhythm/rate, not the mechanical-activity classification).

Neither models joules, pad placement, or the sync-vs-unsync waveform-timing mechanics themselves - both are "facilitator says it worked or didn't."

**Future build, noted for later, not this pass**: real defibrillator mechanics (energy selection, pad placement, actual sync-pulse timing) AND tethering this to the separate **ZOLL R-series simulator project** (`~/zoll-r-series-simulator`, per project memory) as a real connected device - the same pattern the Medtronic pacemaker already uses in this repo (`window.__pacerBridge`, an overlay contributor on the shared sync bus, not a scenario driver). Worth scoping as its own phase once this one's done, not a footnote here.

## What this pass explicitly does NOT cover (deferred, not forgotten)

- LVAD as distinct from ECMO (partial-pulsatility flow profile).
- Real defibrillation/cardioversion energy mechanics (see REVIEW #6).
- The square-wave/fast-flush test becoming a learner-initiated trigger (currently facilitator-set) — this is a genuinely separate, smaller UI feature, not core to the state model.
- Full post-ROSC care bundle / neuro-prognostication modeling.
- ECMO etCO₂ physiology beyond "hold the authored value" (see REVIEW #4).

## Proposed state-matrix (acceptance-criteria table)

Every row is one `{rhythm category, CPR, support}` combination the tests will check. `—` means "doesn't change the row's outcome."

| Rhythm | CPR | ECMO | Mech. activity | Perfusing? | Pulsatile? | ART render | etCO₂ behavior |
|---|---|---|---|---|---|---|---|
| Organized (sinus, afib, VT w/o arrestActive) | off | off | organized | ✅ | ✅ | normal pulsatile | authored value |
| Ventricular Fibrillation | off | off | fibrillating | ❌ | ❌ | flat/dashed | decays to ~3–5 |
| PEA | off | off | none | ❌ | ❌ | flat/dashed | decays to ~3–5 |
| VT + `arrestActive:true` (pulseless VT) | off | off | none | ❌ | ❌ | flat/dashed | decays to ~3–5 |
| Any non-organized | **good** | off | (unchanged) | ✅ (via CPR) | ✅ (compressions) | pulsatile, reduced amplitude | >10 (ideally ≥20) |
| Any non-organized | **poor** | off | (unchanged) | ✅ (via CPR) | ✅ (compressions, weaker) | pulsatile, low amplitude | ≤10 |
| Any non-organized | off | **on** | (unchanged) | ✅ (via ECMO) | ❌ | flat-but-elevated, NOT arrest styling | holds authored value (no ECMO special-case, REVIEW #4) |
| Organized | off | **on** | organized | ✅ (native, ECMO incidental) | ✅ (native pulse dominates) | normal pulsatile | authored value |
| Any non-organized | **good** | **on** | (unchanged) | ✅ (both) | ✅ (CPR contributes pulse) | pulsatile over elevated baseline | >10, often ≥20 |

## Next steps (implementation, now that the design is approved)

1. Write `engine/clinical/pulsatility.js` against the model above: `mechanicalActivity()`, `getHemodynamicState()` (flow sources + perfusing/pulsatile), `getEffectiveETCO2()`, `achieveROSC()`, plus the two shock actions.
2. Add `state.circulation = { cpr: { active, quality }, lastPerfusingAtMinute }` and `etco2` to `engine/physiology.js`'s `BASE_STATE`.
3. Write the state-matrix tests from the table above (this IS the "clinically meaningful state-matrix testing" the audit asked for, not isolated UI tests).
4. Wire IntelliVue's `perfusing()`, `ecgValue()`, `artPressure()`, and capnogram (`sampleChannel`'s `co2` case) to the new derived functions — extending them, not replacing them, per the audit's own instruction. HemoSphere gets the same MAP/perfusion-gating treatment.
5. Console UI: CPR active/quality toggle, Deliver Shock, Synchronized Cardioversion, achieveROSC trigger.
