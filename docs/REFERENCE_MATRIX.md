# Parameter Reference Matrix

**Training simulation only. Not for clinical use.** This document is the deliverable the original audit brief called for: one row per monitored parameter, showing where it lives across the three control surfaces (IntelliVue, HemoSphere Alta, Facilitator Console), whether it has a waveform, whether it's continuous or intermittent, its units/cadence, and exactly which engine function computes what's actually displayed.

**How to read the "Source" column**: most displayed numbers pass through a layered composition, always in this order (each layer optional — a parameter with no medication overlay skips straight from its authored field to the device):

```
state.<field>  (authored - scripted, facilitator-set, or synced)
  -> getEffective*()   [engine/physiology.js or engine/clinical/pulsatility.js - pacer precedence, perfusion/pulsatility-aware overlay]
  -> getMedicated*()   [engine/clinical/pharmacology.js - infusion/push-drug effect overlay]
  -> device-local rendering (IntelliVue/HemoSphere's own tile/waveform code)
```

If a row's Source column shows only `state.X`, nothing overlays it — the device renders the authored value directly. **HemoSphere's own SV/SVI/SVR/SVRI are a real exception**: those are computed live from CO/height/weight or MAP/CVP/CO by HemoSphere's own local `deriv()`, matching real device behavior (a HemoSphere Alta has no field to directly enter an SVR either) — the shared engine does not author or overlay them at all.

Sourced from the actual running code as of this pass (`engine/physiology.js`, `engine/clinical/pulsatility.js`, `engine/clinical/pharmacology.js`, both device files, `facilitator/console.html`) — not reconstructed from memory. Medication dosing/effect citations live in [`CLINICAL_MODEL.md`](CLINICAL_MODEL.md), not duplicated here.

---

## 1. Cardiac electrical / rhythm

| Parameter | IntelliVue | HemoSphere | Console | Waveform | Continuous / Intermittent | Units | Cadence | Source |
|---|---|---|---|---|---|---|---|---|
| Electrical rhythm | ECG II trace + `*** VENT TACH`/`*** VENT FIB`/etc. banners | *(not modeled — no rhythm-dependent rendering anywhere in this device)* | "Rhythm" dropdown, dual-controlled (BLS/ACLS `ov_rhythm` + Assessments `assess_rhythm`, one shared field) | **Yes** (IntelliVue only) | Continuous | — (categorical, 17-entry `RHYTHM_LIBRARY`) | Waveform: real-time canvas draw. Numeric/label: 4Hz (IntelliVue `numTimer`, 250ms) | `state.rhythm` → `getEffectiveRhythm(state)` (pacer-capture precedence) |
| Heart rate (HR / PR) | HR tile | PR tile (`need:"flow"`) | HR readout tile | Yes, via ECG/Pleth beat timing | Continuous | bpm | IntelliVue 4Hz / HemoSphere 2.5Hz (`uiTimer`, 400ms) | `state.hr` → `getEffectiveHR(state)` (pacer + demand-inhibition) → `getMedicatedHR(state, minute)`. Irregular-rhythm display jitter: `jitterHR()` — display-only, never on the sync wire |
| Pacer (mode/rate/output/sensitivity/capture) | Not a dedicated tile — folds into rhythm label ("Paced (mode)") and effective HR only | Not modeled | **Pacer** subsection, full programming (Patient Assessments & Outputs) | No | Discrete/event | bpm, mA, mV | On facilitator/learner change | `state.pacer.*`, `PACER_MODES` (real Medtronic 5392 modes). The separate hardware pacemaker device has its own full control surface, outside this shared engine |
| Defibrillation/cardioversion event | ECG artifact (0.08s spike + 0.24s blanking, then rhythm resumes) | Not modeled | "Deliver Shock" / "Synchronized Cardioversion" buttons; outcome (Success / Failed to convert) sets target rhythm+HR, optional post-event instability ramp | Yes (artifact only, IntelliVue) | Event, one-shot | — | On click | `defibEventCount` (monotonic counter, clock-independent by design — see field docblock) |

## 2. Vascular pressures

| Parameter | IntelliVue | HemoSphere | Console | Waveform | Continuous / Intermittent | Units | Cadence | Source |
|---|---|---|---|---|---|---|---|---|
| Arterial line (ART/ABP) sys/dia/MAP | **ART** tile — sys/dia and MAP now render at the same size, inline (`"105/65 (78)"`) | **MAP** tile only (sys/dia not separately tiled; `need:"acumen"`, ClearSight-aware) | **BP** tile (sys/dia) + **MAP** tile | Yes (ART canvas, IntelliVue) | Continuous, pulsatile (perfusion/pulsatility-gated — see §"perfusion" below) | mmHg | Same as HR | `getEffectiveSBP/DBP/MAP(state)` (pulsatility overlay: native/CPR-scaled/support passthrough) → `getMedicatedMAP(state, minute)` (MAP only, perfusion-gated) |
| 2nd arterial line (Fem) | **Fem** tile (offset −6/−2 mmHg from ART, same waveform family) | Not modeled | Not modeled | Yes (IntelliVue) | Continuous | mmHg | Same as ART | IntelliVue-local derived offset of `disp.sys/dia` — not an independent shared-engine field |
| Pulmonary artery pressure (PAP) sys/dia/mean | **PAP** tile (only when `state.paCath==="PA"`) | Not modeled — Alta's own parameter set has no PA sys/dia field | PA readout (sys/dia) | Yes (IntelliVue) | Continuous while PA catheter in PA position | mmHg | Same as HR | `state.pa.systolic/diastolic` → `getMedicatedPASys/PADia(state, minute)` (antiarrhythmic/inhaled-vasodilator overlay — PA-selective, deliberately no systemic MAP effect) |
| PAWP / PCWP (wedge pressure) | **PAP** tile's PAWP sub-value — `-- (never)` / `(live)` / snapshot + age | Out of scope for this pass (explicit product decision) | Not modeled | No | **Intermittent** — real wedge-procedure-triggered snapshot, not a live number | mmHg | On `wedge_inflate`→confirmed-wedged→`wedge_deflate` cycle | `state.pawpMeasured` (IntelliVue-local — `{value, measuredAtMs}`, not a shared-engine field) |
| CVP | **CVP** tile | **CVP** tile (`need:"cco"`) | CVP readout | Yes (IntelliVue) | Continuous | mmHg | Same as HR | `state.cvp` direct — no `getEffective*`/`getMedicated*` overlay exists for CVP yet |
| ICP | **ICP** tile (shared-engine mode: mean number only; IntelliVue's own local "practice scenario" mode separately has a full P1/P2/P3 compliance waveform, out of scope here) | Not modeled | ICP readout (Neuro subsection) | Yes (IntelliVue, mean-value trace) | Continuous | mmHg | Same as HR | `state.icp` direct |
| CPP (cerebral perfusion pressure) | **CPP** tile | Not modeled | CPP readout (Neuro subsection), live-updating | No — pure arithmetic, no canvas trace | Continuous (computed) | mmHg | Recomputed every render | `computeCPP(map, icp)` — a pure arity-2 function, no state of its own; each caller supplies whatever MAP it has already resolved |
| Non-invasive BP (NBP/NIBP) sys/dia/MAP | **NBP** tile — bar-graph trend row at the *bottom* of the waveform stack, matching real Philips MX700/MX800 placement; sys/dia+MAP now render at the same size, inline | Not modeled as a distinct cuff parameter | Not modeled distinctly (the `bp.*` field/tile represents the invasive/authored line either device reads) | Trend bars only, no continuous trace | **Intermittent** — facilitator/learner "Start NBP" softkey-triggered cycle | mmHg | On demand | IntelliVue-local (`state.nbpSys/nbpDia/nbpTime`) — not an authored shared-engine field |

## 3. Cardiac output & derived hemodynamics

| Parameter | IntelliVue | HemoSphere | Console | Waveform | Continuous / Intermittent | Units | Cadence | Source |
|---|---|---|---|---|---|---|---|---|
| Cardiac output / index (CO/CI) | **CO/CI** tile — thermodilution, "C.O." softkey-triggered | **CO/CI** tile (continuous, pulse-contour algorithm, `need:"flow"`) **and** **sCO/sCI** tile (STAT, ~2s refresh with realistic noise, `need:"cco"`) | CO readout | No | IntelliVue: **intermittent** (thermodilution). HemoSphere: **continuous** (algorithm) + intermittent-feeling STAT recalc | L/min, L/min/m² | IntelliVue: on `C.O.` trigger. HemoSphere continuous tile: every 2.5Hz tick; STAT: ~2s | `state.co` → `getEffectiveCO(state)` (pulsatility overlay — CPR fixed representative values, zero on true no-flow arrest) → `getMedicatedCO(state, minute)` |
| Stroke volume / index (SV/SVI) | Not modeled | **SV/SVI** tiles | Not modeled | No | Continuous | mL/beat, mL/beat/m² | 2.5Hz | HemoSphere-local `deriv()` (`sv = CO×1000/PR`) — not a shared-engine field |
| Systemic vascular resistance (SVR/SVRI) | Not modeled | **SVR/SVRI** tiles | Not modeled as its own tile | No | Continuous | dyn·s/cm⁵ | 2.5Hz | HemoSphere-local `deriv()` (`svr = 80×(MAP−CVP)/CO`). `getMedicatedSVR(state, minute)` exists in the engine (perfusion-gated) but nothing currently renders it |
| Stroke volume variation / pulse pressure variation (SVV/PPV) | Not modeled (no tile) | **SVV** / **PPV** tiles (`need:"acumen"`) | SVV/PPV readout | No | Continuous *only with a real arterial waveform present* (binary gate, not scaled) | % | Same as HR/MAP | `getEffectiveSVV/PPV(state)` (pulsatility overlay) |
| Hypotension Prediction Index (HPI) | Not modeled | Dedicated HPI gauge view (`need:"adv"` = Swan CCO **and** Acumen IQ) | HPI slider/readout | No (gauge, not a trace) | Continuous | 0–100 (unitless) | Same as HR | `state.hpi` direct |

## 4. Oxygenation & perfusion

| Parameter | IntelliVue | HemoSphere | Console | Waveform | Continuous / Intermittent | Units | Cadence | Source |
|---|---|---|---|---|---|---|---|---|
| SpO₂ / Pleth | **SpO₂** tile + Pleth waveform | Not modeled (Alta has no pulse oximetry) | SpO₂ readout | Yes (IntelliVue) | Continuous, pulsatile — dashes when `!perfusing()` or unmonitored | % | Same as HR | `state.spo2` direct. Waveform pulsatility independently overridable via `state.pulseSignalPleth` (`auto`\|`pulsatile`\|`nonpulsatile`) |
| Perfusion index (Perf) | SpO₂ tile sub-value | Not modeled | Not modeled | No | Continuous, reads ~0 whenever `!pulsatilePleth()` regardless of the SpO₂ number itself | unitless | Same as SpO₂ | IntelliVue-local, driven by `pulsatilePleth()` |
| Central venous oxygen saturation (ScvO₂) | Not modeled | **ScvO₂** tile — real in-vivo calibration workflow (baseline → draw → lab values → calibrate) | ScvO₂ readout | No | Continuous once calibrated | % | Same as HR | `getEffectiveScvO2(state, minute)` (pulsatility overlay — CPR fixed values, floor-decay on true arrest; explicitly 🟡 not independently cited, see `CLINICAL_MODEL.md` §1.5) |

## 5. Respiratory

| Parameter | IntelliVue | HemoSphere | Console | Waveform | Continuous / Intermittent | Units | Cadence | Source |
|---|---|---|---|---|---|---|---|---|
| Respiratory rate (RR) | **RR** tile + Resp waveform | Not modeled | RR readout | Yes (IntelliVue) | Continuous | /min | Same as HR | `state.rr` → `getMedicatedRR(state, minute)` (ungated — a sedative depresses respiration even without mechanical flow) |
| End-tidal CO₂ / capnography | **etCO₂** tile (+ awRR sub-value) + CO₂ waveform | Not modeled | etCO₂ readout | Yes (IntelliVue, amplitude gated by `perfusing()`) | Continuous | mmHg | Same as HR | `getEffectiveETCO2(state, minute)` (pulsatility overlay — 🟢 CITED CPR threshold band, no-flow floor-decay; see `CLINICAL_MODEL.md` §1.4–1.5) |

## 6. Temperature

| Parameter | IntelliVue | HemoSphere | Console | Waveform | Continuous / Intermittent | Units | Cadence | Source |
|---|---|---|---|---|---|---|---|---|
| Temperature | **Temp** tile (single probe) | Facilitator driver only (`f_temp`) — **not displayed as its own monitored tile anywhere on this device's screen**, despite being tracked/synced | Temp readout | No | Continuous | °C | Same as HR | `state.temp` direct. **Known limitation**: single-probe only — real IntelliVue references show dual-probe + ΔTemp, not modeled here |

## 7. Renal/GU & drainage output

| Parameter | IntelliVue | HemoSphere | Console | Waveform | Continuous / Intermittent | Units | Cadence | Source |
|---|---|---|---|---|---|---|---|---|
| Urine output | Not modeled | Not modeled | **Renal/GU** subsection — collection device type + volume | No | Documentation entry (facilitator-set) | mL | On facilitator change | `state.urineOutput.{deviceType, volumeMl}` — `deviceType` is documentation-only, confirmed it never changes how `volumeMl` behaves |
| Chest tube output (5 sites: R Pleural, R Mediastinal, Blake, L Pleural, L Mediastinal) | Not modeled | Not modeled | **Chest Tube Output** subsection, one slider per site | No | Documentation entry (facilitator-set) | mL | On facilitator change | `state.chestTubes.*` |

## 8. Monitoring status (not a vital sign — a connection state)

| Parameter | IntelliVue | HemoSphere | Console | Notes |
|---|---|---|---|---|
| "Monitored" toggle, 12 groups (hr/bp/pa/cvp/co/svv/ppv/scvo2/spo2/rr/temp/icp) | Corresponding tile shows "not connected"/dashes via `state.show.*` (derived from `monitored`) | Corresponding tile shows "Not connected" via `paramAvailable()`'s `engineMonitored` check (checked *before* HemoSphere's own native sensor gate) | One checkbox per group (Patient Assessments & Outputs) | `state.monitored.*`, `MONITOR_GROUPS`, `isMonitored(state, group)` — independent of both the raw authored number (unrestricted) and the patient's actual physiology (`isPerfusing`/`isPulsatile`) |
| Pulse-signal override (arterial line / pulse ox, independently) | ART waveform / Pleth waveform + Perf-index respect this directly | *(HemoSphere's ART/pulse rendering doesn't currently read this override)* | Auto / Pulsatile / Non-pulsatile mode-pair under the SpO₂ slider | `state.pulseSignalArterial`, `state.pulseSignalPleth` — lets a facilitator author "poor perfusion, non-pulsatile signal, any chosen number" without requiring true arrest or ECMO |

## 9. Medications & infusions

Not repeated here — every drug, dose, onset/duration curve, and citation (or explicit 🟡 REASONED / 🔴 NOT MODELED flag) is documented in **[`CLINICAL_MODEL.md`](CLINICAL_MODEL.md)**, which is itself generated from the same source-of-truth files (`engine/clinical/formulary.js`, `engine/clinical/pulsatility.js`) this matrix draws from. In summary: continuous infusions (`state.drips.*`, 11 drugs) ride the same `getMedicated*()` overlay chain documented in the tables above; IV push drugs (`state.medications.pushes[]`) apply a rise-then-decay triangular effect curve per dose, independently stacking.

---

## Known cross-cutting simplifications (not oversights — flagged so a reviewer knows to look for them)

- **HemoSphere Alta has zero rhythm-dependent rendering** — confirmed via grep, no `rhythm` reference anywhere in that file. Its waveform/PR tile are driven purely by rate numbers, so a PEA arrest (organized-looking rhythm, no pulse) shows a rate number there exactly like a normally-conducted beat would — a documented, pre-existing simplification, not something this pass changed.
- **HemoSphere's own SV/SVI/SVR/SVRI/CI are always locally-derived**, never force-matched to the shared engine's own authored values (there is no field to directly enter an SVR on a real HemoSphere either).
- **PAOP/PAWP on HemoSphere is explicitly out of scope** for this pass — confirmed with the user; IntelliVue's real wedge-procedure workflow was the only fix built.
- **IntelliVue's ICP compliance waveform (P1/P2/P3 morphology)** only exists in that device's own local "practice scenario" mode — the shared engine only carries the mean ICP number.
- **NBP/PAWP are the only two genuinely intermittent numeric measurements** in this whole matrix; every other numeric tile updates continuously (subject to the "monitored"/perfusion/pulsatility gates above), even where a real device's own measurement technology (e.g. thermodilution CO) is itself intermittent in practice — IntelliVue's own CO/CI tile is the one other explicitly intermittent, trigger-based exception.
