# Audit Remediation — Final Validation Report

**Training simulation only. Not for clinical use.** This is the closing deliverable for the comprehensive editorial/clinical-fidelity/functional/technical audit pass requested for the Clinical Patient Simulator (IntelliVue, HemoSphere Alta, Facilitator Console). It covers the **final remediation queue** — the nine items triaged and fixed in this pass, plus one same-session addendum raised directly by the user mid-review. Earlier audit work (defib artifact, ART/IBP pulsatility split, shock/cardioversion outcome selection, Clinical Change fast-forward/commit controls, the AFib pressure-waveform discontinuity fix, rhythm-library expansion) was already implemented, tested, and pushed before this queue began — see `CLAUDE.md`'s dated Round 3/4 sections for that full history. Nothing in this document repeats or re-verifies that earlier work.

## Methodology

Per the original brief's own instruction, every item below was: (1) investigated against the running code before any change was made, (2) implemented only where a fix was unambiguous, (3) run through the full automated test suite, (4) verified live in a real browser — real clicks/drags where UI interaction was in scope, not `.click()` synthetic events alone (this codebase has a documented history of bugs that only reproduce under real mouse events, see `CLAUDE.md`'s Round 2/3 entries) — and (5) for two items, cross-checked directly against real Philips IntelliVue MX700/MX800 reference photographs the user supplied mid-review.

**Commands run** (repeated after every change, not just once at the end):
```bash
export PATH="$HOME/.local/node-v22.14.0-darwin-arm64/bin:$PATH"
node --test
```
Final result: **294/294 passing**, zero failures, zero skipped, throughout the entire pass. This queue's own changes are exclusively page-integration/canvas/CSS work in files with no existing unit-test coverage for their internal functions (the established, pre-existing convention for this class of change in this project — see `CLAUDE.md`) — the 294 count is unchanged from before this queue started; correctness here rests on the live-browser verification recorded below, not new automated tests, except where noted (item 9 added a new debug hook used for programmatic waveform verification).

---

## Findings & fixes, severity-triaged

### 🔴 Critical

**1. `consoleTick()` had no crash recovery — a single thrown error permanently killed the tick loop.**
- *Root cause*: the animation-frame loop driving all ramp progression, override releases, and auto-advance had no error boundary. Any exception (a bad scenario field, an edge case in a new feature) would silently stop `requestAnimationFrame` from re-arming — the console would appear to freeze mid-session with zero visible indication anything had gone wrong.
- *Fix*: wrapped the tick body in try/catch inside a new outer `consoleTick()` wrapper; on a caught error, the loop still re-arms via `finally`, and a dismissible on-screen banner (`#tickErrorBanner`) surfaces after the 3rd-consecutive-second of errors so a facilitator running a live class isn't left silently guessing.
- *Verified*: direct fault injection (a self-clearing `window.__testThrowInTick` flag checked at the top of the tick body) confirmed the banner appears, the error is logged, and the loop demonstrably keeps functioning (ramps/overrides continued progressing) after the injected failure — then confirmed clean with the flag removed.
- *File*: `facilitator/console.html`.

### 🟠 High

**2. PAWP/PCWP displayed as a continuously-updating number every frame, with no wedge maneuver ever required.**
- *Root cause*: the PAP tile's PAWP sub-value was wired straight to a live-computed number, regardless of whether the PA catheter's balloon had ever actually been inflated. Real monitors only show a wedge pressure as a deliberately-acquired, intermittent snapshot — this taught the wrong mental model of how a wedge reading is actually obtained.
- *Fix*: added `state.pawpMeasured` (`{value, measuredAtMs}` or `null`), captured only on a genuine `wedge_inflate` → confirmed-wedged → `wedge_deflate` cycle (the exact sequence the wedge modal's own instructional text already describes). The tile now shows `-- (never)` before any real reading, `(live)` while actively wedged, or the last snapshot with an age indicator otherwise.
- *Verified live*: fresh scenario load → `-- (never)`; full wedge procedure (inflate to 1.25 mL → confirm wedged → deflate) → captures and displays a real value with `(now)`; backdating the timestamp → correctly ages to `(3m)`; a partial/aborted inflation attempt (never reaching the wedge threshold) followed by deflate → correctly does **not** overwrite the existing genuine reading.
- *File*: `devices/intellivue/intellivue_sim_monitor.html`.

**5. Shock/Synchronized Cardioversion's target-rhythm dropdown was stuck at 3 hand-coded options while the rhythm library had grown to 17.**
- *Root cause*: `#shock_target_rhythm` was never updated when `RHYTHM_LIBRARY` was expanded elsewhere in the same file — a facilitator running a code with any outcome outside "Sinus Rhythm / Sinus Tachycardia / Atrial Fibrillation" (a paced rhythm, any AV block, junctional, etc.) had no way to select it.
- *Fix*: folded into the same population loop `ov_rhythm`/`assess_rhythm` already use — one source of truth, zero hand-duplicated option lists left in the file.
- *Verified live*: dropdown now shows all 17 rhythms, default unchanged ("Sinus Rhythm," still first); a full real-click end-to-end test selecting "Second-Degree AV Block (Type I)" (previously unreachable) and clicking Deliver Shock correctly set `state.rhythm` and logged the change.
- *File*: `facilitator/console.html`.

**9. VT/Torsades ECG morphology was two summed sine harmonics with zero beat-to-beat variability — the audit's own explicitly named weakest waveform.**
- *Root cause*: both rhythms were special-cased in `ecgValue()` as raw parametric sine functions, bypassing the file's entire per-beat rendering pipeline (`pickRhythmTiming`/`advanceCardiac`/`ecgComplex`) that every other rhythm — including PVCs and escape beats, which already draw a correct wide/bizarre QRS shape — goes through.
- *Fix*: **VT** now flows through the normal per-beat state machine, reusing the exact wide/notched/bizarre complex shape already proven correct for PVC/escape beats (real monomorphic VT is textbook-described as "a fast run of PVC-like wide complexes"), at a genuinely regular rate. **Torsades** was rebuilt with a truly bipolar amplitude envelope (two incommensurate slow tones, so it now genuinely crosses baseline — the "twisting" the rhythm is named for) with correlated carrier-rate wander and a 2nd harmonic sharpening each peak toward a QRS-like point, replacing the old fixed-frequency, always-positive envelope. **AFib** was investigated and confirmed already solid (real per-beat R-R variability, fibrillatory baseline noise) — left unchanged.
- *Verified*: a new `__debugSampleECG` testing hook (same convention as the existing `__debugSampleART`) drove the waveform programmatically. VT: peak-to-peak spacing measured at a steady ~319ms across 25 beats, exactly matching HR 188 (confirming genuine per-beat regularity, not a static tone). Torsades: windowed RMS envelope measured cycling repeatedly between ~0.02 and ~0.68 over a 30-second sample (genuine polarity swings through baseline, not noise) — no NaN/Infinity in either case. Both also confirmed visually via screenshot (driven through `driveLocalFrames` to force a full canvas repaint in this environment's backgrounded test tab).
- *File*: `devices/intellivue/intellivue_sim_monitor.html`.

### 🟡 Medium

**3. HemoSphere's every sensor-source label read "IQ Sensor" regardless of which sensor a parameter actually needs.**
- *Root cause*: `buildTiles()`/`buildCockpit()`/`activeAlarms()` all hardcoded the string, ignoring the `P[k].need` field that was already correctly gating parameter *availability* — a CVP tile (PAC-only) claimed the identical source as an SVV tile (arterial-line-only).
- *Fix*: `sourceLabel(k)`, driven by the existing `need` field and disambiguated by `drv.mode` (Swan CCO / Acumen IQ / ClearSight / Oximetry Cath / Swan CCO + Acumen IQ).
- *Verified live*: tiles and cockpit globes show correctly differentiated labels simultaneously; driving through all three sensor modes programmatically confirmed the full disambiguation table.
- *File*: `devices/hemosphere-alta/hemosphere_alta_sim.html`.

**6. ART/PAP/Fem tiles had no visible mmHg unit once boot-time JS overwrote their corner placeholder with the real alarm-limit range.**
- *Root cause*: the `.lim` corner span's `"mmHg"` was only ever static HTML placeholder text — `refreshLimLabels()` immediately replaces it with the parameter's real alarm-limit range (that corner's actual, correct purpose), leaving these three tiles with no unit displayed anywhere near the value, unlike NBP's already-correct pattern.
- *Fix*: added "mmHg" to the `.sub` row, matching NBP.
- *Verified live*: screenshot confirms `ART 101/64 (76) mmHg`, matching NBP's own layout exactly; the `.lim` corner's alarm-range behavior is unaffected.
- *File*: `devices/intellivue/intellivue_sim_monitor.html`.

**7. Numeric tile column order didn't match the waveform panel's row order** *(and a placement correction found from user-supplied reference photos)*.
- *Root cause*: RR sat 3rd in the numeric column (right after HR/SpO₂) but 8th-of-9 in the trace panel — a learner scanning the screen couldn't match a tile to its own waveform at a glance.
- *Fix, round 1*: reordered to follow `WAVE_ORDER`'s sequence, threading NBP in beside ART/Fem (reasoned as "same pressure family").
- *Fix, round 2 (correction)*: the user supplied three real Philips IntelliVue MX700/MX800 photographs. All three showed NBP's row is a bar-graph trend at the very **bottom** of the trace stack (below Resp/CO₂), not beside the continuous pressure lines — moved NBP (grouped with CO/CI, also intermittent/waveform-less) to the bottom of the column, directly before Temp, exactly matching all three references.
- *Verified live*: final deployed tile order (`HR → SpO₂ → ART → PAP → CVP → ICP → CPP → RR → etCO₂ → CO/CI → NBP → Temp`) confirmed via a raw HTML fetch against production, byte-for-byte.
- *File*: `devices/intellivue/intellivue_sim_monitor.html`.

**10. MAP rendered as a small, corner-positioned number under ART/NBP/PAP, not matching the primary sys/dia number's prominence** *(user-reported addendum, mid-session)*.
- *Root cause*: MAP lived in the tile's `.sub` row (15px, absolutely positioned bottom-right, 0.85 opacity) while sys/dia used the tile's primary `.big` styling (31–39px depending on tile). Real IntelliVue references show MAP prominently, not as corner text.
- *Fix*: moved the MAP value inside the same `.big` element as sys/dia, as a sibling `<span>` (so it inherits the identical computed font-size/weight for free) rather than a separate small element. **A real bug caught during this fix**: the first version set `.textContent` directly on the shared wrapping element, which silently destroyed the newly-nested MAP span on the very next render (`byId("v_abpmap")` began returning `null`) — fixed by keeping the existing `id`s on dedicated inner spans instead of the wrapping div, so every pre-existing `updateNumerics()` assignment continues to work unmodified.
- *Verified live*: `ART 105/65 (78)`, `PAP 24/9 (14)`, `NBP 102/65 (77)` all render at full primary size with no overflow, confirmed at both a wide (800px) and the narrow (577px) viewport this project's own testing has used throughout.
- *File*: `devices/intellivue/intellivue_sim_monitor.html`.

### 🟢 Low

**4. ScvO₂ terminology was inconsistent** — some UI strings said "SvO₂" despite the tile/field/majority of labels already consistently using "ScvO₂."
- *Fix*: standardized every on-screen string (calibration button, hint text, modal title, lab-values row, calibration status messages) to the codebase's own already-predominant term.
- *Verified*: grep confirms zero remaining "SvO₂"/"SvO2" strings in the file; live-checked in the calibration modal.
- *File*: `devices/hemosphere-alta/hemosphere_alta_sim.html`.

**8. Shock/Cardioversion/ROSC controls required digging through a collapsed rail group during a real code.**
- *Fix*: added a "Shock / Cardioversion / ROSC ▸" button to the always-visible launcher bar, same jump-to-section pattern as the existing "Scenario & Stage" button — opens BLS/ACLS and scrolls directly to the Defibrillation/Cardioversion section. ROSC has no separate control of its own to jump to (it's the outcome of Success + either shock button), so one target correctly covers all three.
- *Verified live*: a real mouse click from a collapsed BLS/ACLS group correctly landed the Defibrillation/Cardioversion section at the top of the viewport (a stale-coordinate false negative was hit and root-caused during verification — batching the scroll+click+wait into one round-trip resolved it; see the session record for the full debugging trail, kept here only as the resolved result).
- *File*: `facilitator/console.html`.

---

## Deployment verification

All ten fixes above are committed (4 commits: `5146f2f`, `3d541bb`, `a7614e2` for items 1–9, plus item 10 pending in the working tree as of this report) and — for items 1–9 — pushed to `main` and confirmed live against production via direct `curl` checks against `https://ct-surgery-sim.netlify.app`, not just a successful `git push`:

- Shock rhythm dropdown: confirmed empty in raw deployed HTML (JS-populated from the full library), not the old 3-option list.
- IntelliVue tile order: confirmed byte-for-byte (`t_hr, t_spo2, t_abp, t_abp2, t_pap, t_cvp, t_icp, t_cpp, t_rr, t_co2, t_coci, t_nbp, t_temp`).
- HemoSphere ScvO₂ terminology: confirmed zero remaining "SvO2"/"SvO₂" occurrences in the deployed file.
- Launcher quick-access button: confirmed present in deployed HTML.

## Remaining limitations & items needing clinician/product-owner review

Nothing in this queue required a new clinical-content decision (unlike the earlier pharmacology/pulsatility phases, which are already gated in `CLINICAL_MODEL.md`'s sign-off checklist) — every fix here was either a code defect, a display/placement correction, or a UI-workflow addition. That said, several **known, deliberate simplifications** surfaced or were reconfirmed during this pass and are worth a reviewer's explicit attention:

- **HemoSphere Alta PAOP/PAWP remains explicitly out of scope** — confirmed with the user before this pass began; only IntelliVue's wedge-procedure workflow was built. If HemoSphere-side PAOP is ever wanted, it needs its own scoping pass, not an extension of the IntelliVue fix.
- **Single-probe temperature only** — real IntelliVue references show dual-probe + ΔTemp; not modeled anywhere in this simulator. Noted, not built (out of the original queue's scope).
- **HemoSphere has zero rhythm-dependent rendering** (pre-existing, reconfirmed via grep during item 9's investigation) — a PEA arrest shows a normal-looking rate on HemoSphere's PR tile, same as any organized rhythm. This is a real, named simplification from an earlier phase (see `CLAUDE.md`), not something this pass touched or claims to have fixed.
- **VT/Torsades morphology is still electrical-representation-only** — no energy/joules mechanics, pad placement, or real sync-pulse timing (that's explicitly a future build, tethered to the separate ZOLL R-Series simulator project per `engine/clinical/pulsatility-design.md` REVIEW #6). This pass improved *waveform shape and timing realism only*, within that existing, unchanged scope boundary.
- **The reference-photo-driven NBP placement correction (item 7) was verified against three photographs, not a written Philips specification.** The photos were consistent with each other and with this project's own prior IntelliVue conventions (alarm limits in the `.lim` corner, etCO₂/awRR paired, CPP directly after ICP), which increases confidence, but a clinician/biomed reviewer with hands-on access to a real MX700/MX800 would be the authoritative check if this placement is ever questioned.
- **Item 8's verification (launcher jump-to-section) surfaced a real testing-methodology artifact worth flagging for future verification work in this project**: a `<details>` toggle immediately followed by `scrollIntoView()` can land on the wrong final scroll position if the click and the scroll-into-view are split across multiple separate browser-automation tool calls (each of which can let this environment's tick loop advance and shift layout in between) — batching them into a single round-trip resolved it reliably. Not a product bug; a note for whoever next does real-click verification on this file.

## Cross-reference

- **Parameter-level detail** (location, waveform, source function, cadence, units for every monitored value across both devices): [`REFERENCE_MATRIX.md`](REFERENCE_MATRIX.md).
- **Clinical/pharmacological citations and sign-off checklist** (unchanged by this pass): [`CLINICAL_MODEL.md`](CLINICAL_MODEL.md).
- **Full project history, phase-by-phase**: `CLAUDE.md` at the repository root.
