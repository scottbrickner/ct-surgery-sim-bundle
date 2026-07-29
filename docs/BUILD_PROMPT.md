# Build Prompt: CT Surgery Sim Bundle (IntelliVue + HemoSphere Alta + Pacemaker)

> Paste this whole document to a new Claude Code session to kick off the build. It's written as a project brief — background, decisions already made, and a phased plan — not as a finished spec, so the build session should still confirm open items in §8 before Phase 1.

## 1. Goal

Build a **bundled, cross-syncing** training simulation for a CT (cardiothoracic) surgery nursing class: three high-fidelity device simulators —

1. **Philips IntelliVue** patient monitor
2. **Edwards HemoSphere Alta** hemodynamic monitor
3. **Medtronic 5392** temporary pacemaker

— driven by **one shared physiology engine**, controlled by **one facilitator console**, running a single continuous 3-part cardiogenic-shock case (bedside settle-in → tamponade/arrest → ECMO cannulation). The three devices must "speak to each other": a pacer capture loss should be visible on the IntelliVue ECG, a titrated pressor should move both the IntelliVue numerics and the HemoSphere Alta's derived CO/CI/SVR — not just its own local slider.

Training simulation only, not for clinical use — same disclaimer posture as the sibling sims below.

## 2. What already exists — reuse, don't rebuild from scratch

This is the most important section. Three real prototypes already exist and are more mature than a fresh build would start from:

- **`~/pacemaker-sim`** (git repo, actively developed) — a mature, single-file HTML Medtronic 5392 dual-chamber temporary pacemaker simulator. Already has:
  - Three roles via URL/body-class: facilitator (default), `?role=learner`, `?role=practice`.
  - **Cross-device sync already built and working**: `BroadcastChannel('sim5392')` for same-machine multi-window, plus a **WebSocket relay** (`5392-relay/server.js`, Node + `ws`, room-by-6-char-code, rebroadcasts arbitrary JSON `state` payloads, ping/peers heartbeat) for real cross-device pairing, with QR/short-code pairing UI and reconnect/backoff logic. Deploy target is Render.com (or Railway/Fly/Azure).
  - This relay is **protocol-agnostic** — it just relays JSON state to everyone in a room. That makes it the natural bus for the whole bundle, not just the pacemaker: IntelliVue, HemoSphere Alta, and an iPad pacer view can all join the same session code as peers.
  - Scenario data: `pace-scenarios.json` (12 PACE-prefixed level-of-care cases) + `learner-practice-data.json` (threshold-trainer randomization, fault-action map, MCQ bank, rubrics — richer self-practice-mode data model).
  - Training vs. Validation mode distinction already exists (Validation hides facilitator-only flags from the learner).
  - Governing docs already in place: `CLAUDE.md`, `README.md`, `docs/PHASE1_KICKOFF.md`, `docs/ENHANCEMENT_BRIEF.md`, `docs/LEARNER_MODE_BRIEF.md`. Enhancement phases 1–6 are complete; a second "self-directed practice mode" roadmap is mid-flight (P1 done, P2–P7 planned).
  - Reference docs already collected at `~/pacemaker-sim/docs/references/` (Medtronic 5392 tip card + compatibility-components manuals, plus some Cerner/charting docs). Note: that directory's name has a literal trailing `: ` (colon-space) — a shell-unfriendly artifact, worth renaming if you touch it.
  - A second copy lives at `~/Claude/Projects/Knowledge Hub | Critical Care/5392 Pacemaker Simulator/` — confirmed to be an **older deployed/distribution snapshot** (matches the Netlify static build), not a separate lineage. Treat `~/pacemaker-sim` as the source of truth; that folder also holds the facilitator/learner docx guides and the relay server code referenced above.

- **`~/Claude/Projects/Nurse Residency/Sim Monitors - IntelliVue & HemoSphere/`** — three single-file HTML prototypes, no framework, no build step:
  - **`HemoSphere_Alta_Sim.html`** — already strong conceptual fidelity to the real Edwards HemoSphere Alta: dark UI, ART waveform strip, CO/CI, sCO/sCI STAT, SV/SVI, SVV/PPV, SVR/SVRI, MAP, PR, CVP, ScvO₂, HPI panel, GDT screen, plus trend/tabular/"cockpit" views. Has a facilitator side-drawer with sliders, rhythm dropdowns, waveform-morphology toggles, and "Progressive Transition" ramping.
  - **`IntelliVue_Sim_Monitor.html`** — already strong fidelity to a Philips IntelliVue MX-series monitor: black chrome, waveform area, numeric tiles (HR/ECG, SpO₂, RR, NBP, ART, 2nd arterial line, PAP/PAWP, CVP, ICP/CPP, etCO₂, C.O./C.I., Temp), softkey row, and procedural modals (thermodilution C.O. trial, hemo calculator, PA wedge/balloon syringe, fast-flush square-wave test). Same facilitator side-drawer pattern as HemoSphere.
  - **Both of the above already hardcode 4 duplicate "CT Surgery scenarios (stepped)"**: SCE1 aortic dissection, **SCE2 MVR/CABG bleeding → tamponade**, SCE3 Maze/pacing optimization, SCE4 post-TAVR complete heart block — with Prev/Next/Reset controls, actively wired to the shared state object. These overlap heavily with the docx case study below and should be **consolidated, not left duplicated**.
  - **`IntelliVue_Tachy_DualScreen.html`** — a fork of `IntelliVue_Sim_Monitor.html` with the CT scenarios replaced by a scripted SVT/adenosine/cardioversion teaching case. Its one unique contribution: **the pop-out pattern** — a "Open Learner Monitor" button does `window.open(location.pathname+"?role=learner")`, and the facilitator window `postMessage`s state to the spawned window on a timer, which merges it in and hides its own facilitator chrome via `body.learner` CSS. **This is the working prototype for "pop out screens."** Generalize it into the other two files, but replace the raw `postMessage` transport with the same BroadcastChannel/relay mechanism pacemaker-sim already uses — that's strictly more robust (survives cross-device, has reconnect logic) and gives you one sync mechanism to maintain instead of two.

- **`~/vasoactive-sim/docs/references/`** already has a Philips IntelliVue MX Patient Monitor IFU manual and the CP4-156 vasoactive/pressor formulary (Attachment B) — reusable for drip-rate math and IntelliVue label/unit accuracy (the case study's epi/levo/vasopressin/milrinone/propofol/fentanyl doses should resolve the same way the vasoactive sim's `formulary.ts` does).

## 3. Core architectural decisions (already made — build to these, don't re-litigate)

1. **Single shared physiology engine, not three independent devices.** One module owns HR, rhythm, BP/MAP, PA systolic/diastolic, CVP, CO/CI, SVR(I), SVV/PPV, ScvO₂, HPI, SpO₂, RR, temp, every drip rate, chest-tube output, and pacer capture state. IntelliVue and HemoSphere Alta render *views* of this engine — they stop owning local slider state once wired in. The pacemaker's captured/paced/intrinsic state is an **input** to the engine, not just a local display: loss of capture should revert the visible rhythm to the underlying escape rhythm on the IntelliVue ECG, matching the case study's arrest transition.
2. **Sync bus = pacemaker-sim's existing mechanism, extended to all surfaces.** BroadcastChannel for same-machine facilitator + pop-outs; the existing WebSocket relay (session code + QR pairing) for real cross-device use. IntelliVue, HemoSphere Alta, Pacemaker, and an optional iPad pacer view all join the same session code as peers over one bus — don't invent a second transport.
3. **Facilitator control = scripted timeline with live override.** One console advances through the case study's exact steps (Next/Prev/Reset) — arrival vitals → tamponade onset ramp → arrest → sternotomy → ECMO decision points — while also exposing the sliders/inputs each device prototype already has, so the facilitator can nudge any vital, drip, or pacer parameter at will mid-case. This mirrors the pattern already validated in the vasoactive-sim and pacemaker-sim facilitator consoles.
4. **Pop-out windows for all three (four, with iPad) surfaces.** Generalize `IntelliVue_Tachy_DualScreen.html`'s `?role=learner` pattern into every device file, routed over the shared sync bus.
5. **iPad pacer tie-in is a relay peer**, joining the same session code as a learner-role client of the existing pacemaker-sim over the already-working relay. Confirmed **optional/optimization**, not required for v1.

## 4. Unified scenario — the flagship case (build this first, as one continuous session)

Transcribed from the attached case-study docx. Build this as the primary scenario driving the shared engine; treat the existing CTSCN 4-pack and PACE-12 pacer library as each device's separate secondary/practice content, not something to merge into this schema.

**Patient:** Mike O'Phenolate, 64M. PMHx: A-fib, DM2, HTN, HF (EF 30%). Ex-smoker (quit 10y). Presented with CP, LHC showed diffuse 3-vessel disease, transferred, received CABGx3 + MVR + MAZE, difficult separation from CPB.

### Part 1 — Bedside settle-in (initial arrival to unit)
- VS: HR 90 (AV paced), BP 102/65, SpO₂ 98%, RR 12, T 36.2
- Neuro: sedated, goal RASS −2, withdraws to pain, MAE to painful stim
- Cardiac: epicardial pacer DDD, rate 90, 9 mA output, 1.5 mV sense. +1 b/l radial, doppler b/l DP/PT, skin cool, 5s b/l LE cap refill, 3s b/l UE cap refill, S1S2 + friction rub audible.
- Lines: RIJ CCO PA cath (45cm) — CO 4.2/CI 1.9, SvO₂ 60, T 36.2; dual-lumen cordis (KVO lumen 1, epi/levo lumen 2); R radial a-line; L AC 18ga PIV.
- Resp: 8.0 ETT @23cm at lip; vent AC/12/TV500/PEEP8/FiO₂100%; iNO 20ppm; diminished BS all fields. 5 chest tubes (R pleural 15mL, R mediastinal 25mL, blake 50mL, L pleural 50mL, L mediastinal 50mL), sanguineous.
- GI: OGT taped to ETT, hypoactive BS, abdomen soft. GU: Foley, 50mL/hr in urimeter.
- Skin: midsternal incision dermabonded, LPWT dressing, no pressure ulcers.
- Drips: epi 2 mcg/min, levo 7 mcg/min, milrinone 0.25 mcg/kg/min, propofol 75 mcg/kg/min, fentanyl 50 mcg/min.
- Teaching focus: two RNs settling a fresh post-op CT surgery patient into bed — line/drip/vent verification and baseline assessment. No engine transition here; this is an assessment/orientation step.

### Part 2 — Tamponade → arrest (same patient, hours later)
- Scenario start: HR 90 (AV pacing), BP 110/70 (MAP 73), PA 38/12, CVP 8, SpO₂ 97% on 21%. Drips: epi 2, levo 5, milrinone 0.25, propofol 50, fentanyl 50.
- Recent events: received 2U PRBC, 1 FFP, 1 platelet for continued sanguineous chest-tube drainage; **no chest-tube drainage in the last hour** — the classic false-reassurance sign (output stopped because it's tamponading, not resolving).
- **Tamponade onset** — scripted 5-minute ramp: HR 100→135; BP 110/70(73)→72/58(65); PA 38/12→45/15; CVP 8→15.
- Expected learner action: recognize tamponade physiology, call for emergent sternotomy.
- **Arrest at minute 8**: HR shows PEA (150bpm on strip, no pulse); BP/PA/CVP flatline 0/0; pulse ox inoperative. Sternotomy performed at bedside, chest opened — model this as a hard scripted state flag/event, not a facilitator slider.

### Part 3 — ECMO cannulation / mechanical circulatory support
- Post-sternotomy: tamponade resolved, patient persistently hypotensive.
- Start: HR 140 ST, BP 78/60 (63), SpO₂ 86% on FiO₂ 100%. Drips: epi 10, levo 25, vasopressin 0.02 units/hr, propofol 150 mcg/kg/min, fentanyl 50 mcg/min, milrinone 0.125 mcg/kg/min, insulin 5 units/hr, vanco IVPB. Hemodynamics: PA 35/18, CVP 12, CO/CI 4.0/1.7, SVR 1900.
- Teaching/debrief prompts (discussion-driven, not engine-scored): mechanical support options — IABP (no, indirect offload only, no direct CO/CI increase), Impella (maybe, increases CO/CI directly but not bedside-placeable), ECMO (yes if criteria met — bedside install, rapid pressor wean). Branch discussion: vasoplegia with RV failure, pressors escalated to 3–4 agents without effect, methylene blue vs. Cyanokit. Extension prompt: "what would this look like for a transplant candidate" — discussion-only, not a state branch for v1.

## 5. Facilitator-adjustable parameters (must be live-editable, not just scripted)

HR/rhythm, SBP/DBP/MAP, PA systolic/diastolic, CVP, CO/CI, SV(I), SVV/PPV, SVR(I), ScvO₂, HPI, SpO₂, RR, Temp, each drip rate independently (epi, levo, milrinone, propofol, fentanyl, vasopressin, insulin), pacer mode/rate/output/sensitivity/capture state, chest-tube output rate (per tube), cardiac-arrest/PEA toggle, sternotomy-performed flag, ECMO-cannulated flag.

## 6. Fidelity bar per device (preserve and extend what's already built — don't restyle from scratch)

- **IntelliVue**: keep the existing MX-series black chrome, waveform area, softkey row, and procedural modals (thermodilution CO, hemo calculator, PA wedge, fast-flush). Add: pacer-spike overlay on the ECG trace reflecting paced/captured/lost-capture state from the shared engine.
- **HemoSphere Alta**: keep the existing Acumen IQ/FloTrac terminology, CO/CI/SVV/PPV/SVR panel, HPI/GDT screens, cockpit/trend/tabular views. Rewire its displayed values to read from the shared engine instead of its own local sliders.
- **Pacemaker**: keep the existing Medtronic 5392 engine (modes, connections/fault modal, relay pairing). Wire its captured/paced/intrinsic state as a two-way link with the shared engine (currently it's a self-contained display).

## 7. Real-world room setup (context only — not app scope, but shapes what "speak to each other" needs to support)

Per the docx supply list: Cardinal TV as the primary monitor display (**IntelliVue should be the one designed to project/pop-out to the room's main TV**), an iPad specifically for the pacer sim, plus a physical crash cart / open-chest cart / chest tubes / a-line & PA-cath pressure tubing / moulage for the hands-on side of the sim. Notably, the docx separately lists wanting NFC chips under moulage skin for peripheral pulses/heart sounds/lung sounds/pupils — that's a hardware idea for a future iteration, out of scope for this software bundle, but flagging it since it implies the physiology engine may eventually need to drive more than screens.

## 8. Decisions

1. **Repo & distribution — RESOLVED.** New GitHub repo (not an extension of `~/pacemaker-sim`), pulling in the three device files + pacemaker engine as a starting baseline. This bundle lives with the CT surgery class's Microsoft Teams — the class accesses it via a Teams/SharePoint-embedded link, the same distribution model already documented for the standalone pacemaker sim (`5392-Simulator-SharePoint-Access-Guide.docx`, and `5392-netlify/netlify.toml`'s CSP already allows SharePoint iframe embedding — reuse that CSP pattern for whatever static host is picked). The GitHub repo is source control either way; static hosting can be GitHub Pages or a Netlify/similar static host in front of it, then iframed into the Teams channel/SharePoint page.
2. **Relay hosting — RESOLVED.** GitHub cannot host the relay — GitHub Pages is static-file hosting only, with no persistent server process and no WebSocket support, so the relay (`5392-relay/server.js`, a live Node/`ws` process) needs a separate always-on host regardless of where the repo lives. Given Keck's existing Microsoft 365/Teams/SharePoint environment, **host the relay on Azure App Service** (WebSocket-capable, fits existing IT/procurement path) rather than Render/Railway/Fly — those remain fine as a cheap dev/testing fallback before Azure is provisioned, but Azure should be the target for the classroom-facing deployment. Same-machine multi-window facilitator+projector setups still work over BroadcastChannel alone with zero hosting, regardless of this decision — only cross-device (iPad pacer, or a second facilitator machine) needs the hosted relay.
3. **Scenario schema consolidation.** At least 3 competing formats exist today (this docx case, the duplicated CTSCN-4 pack in HemoSphere/IntelliVue, the PACE-12 pacer library, plus an older LOC-11 TS schema). This build introduces ONE new schema for the flagship case; existing packs stay as each device's own secondary/practice library rather than being merged.
4. **Training vs. Validation mode — RESOLVED: yes, build both**, matching pacemaker-sim's existing distinction (Validation hides facilitator-only flags/fault indicators from the learner-facing pop-outs; Training shows everything).
5. **Debrief — RESOLVED: purely live-facilitated, no in-app scoring or debrief screen.** Do not build vasoactive-sim-style structured scoring/coaching-summary for this bundle — the facilitator runs debrief conversationally after the ECMO scenario using their own judgment. App scope ends when the ECMO discussion prompts (§4, Part 3) are shown; no event log, no scorecard.

## 9. Suggested phased build

- **Phase 0** — Consolidate into one repo/skeleton; port the existing 3 device files + pacemaker engine in as a baseline, unmodified.
- **Phase 1** — Shared physiology engine + unified scenario schema; author the 3-part case from §4.
- **Phase 2** — Wire IntelliVue + HemoSphere Alta to read/write the shared engine (replace local sliders with engine-bound values).
- **Phase 3** — Generalize pop-out (`?role=learner`) + BroadcastChannel/relay sync to all three devices.
- **Phase 4** — Facilitator console: unify the three separate side-drawers into one control surface with Next/Prev scripted steps + override sliders.
- **Phase 5** — Pacer↔ECG/hemo feedback loop (capture loss → rhythm change) + Training/Validation mode across all three devices + optional iPad relay peer.
- **Phase 6** — Provision the Azure relay, wire the Teams/SharePoint-embeddable static deploy (reusing the existing iframe CSP pattern), polish/testing. No debrief/scoring screen — out of scope per §8.5.
