# CT Surgery Sim Bundle

Bundled, cross-syncing training simulation for a CT (cardiothoracic) surgery nursing class at Keck: three device simulators — **Philips IntelliVue** patient monitor, **Edwards HemoSphere Alta** hemodynamic monitor, and a **Medtronic 5392** temporary pacemaker — driven by one shared physiology engine and one facilitator console, running a single continuous cardiogenic-shock case (bedside settle-in → tamponade/arrest → ECMO cannulation).

Training simulation only. Not for clinical use.

**Full spec: [`docs/BUILD_PROMPT.md`](docs/BUILD_PROMPT.md)** — read this first. It has the reuse inventory, architecture decisions, the transcribed flagship scenario, and the phased build plan. This README just orients you in the repo; the build prompt is the source of truth.

## Status

**Phases 0-2 complete.** Phase 0 was a straight, unmodified port of three existing prototypes into one repo. Phase 1 added the shared physiology engine and the unified scenario schema, with the flagship 3-part case authored against it. **Phase 2 wired IntelliVue and HemoSphere Alta to that engine** — both now import `engine/physiology.js` + `engine/scenarioRunner.js` as real ES modules and drive their displays from a new "Shared Flagship Scenario" facilitator-panel section (Part 1/2/3 jump, Next/Prev/Reset, live coach text), instead of only their own pre-existing local scenario packs (which are untouched and still work exactly as before). **The pacemaker is not wired yet** and **the two monitors don't sync with each other or the pacemaker yet** — both are Phase 3 (BroadcastChannel/relay sync + generalized pop-out windows).

**Breaking change from Phase 1: these two device files can no longer be opened by double-click (`file://`).** Browsers block ES module imports (and `fetch`) from local files — each `file://` page is treated as its own opaque origin. Serve the repo root over `http://` instead: `node serve.js` (see below). Everything on each page that doesn't touch the shared engine still works fine either way; only the new "Shared Flagship Scenario" panel section requires the server.

Two known, deliberate display simplifications from Phase 2 (documented in code comments where they occur):
- Neither device force-displays the engine's authored `ci`/`svr`/`svri` — both always compute Cardiac Index and (on HemoSphere) SVR/SVRI live from CO/height/weight or MAP/CVP/CO, matching how the real devices actually work (there's no field to manually enter an SVR on a real HemoSphere Alta either). The flagship case's authored `svr: 1900` for Part 3 won't match HemoSphere's own computed ~1020 — that traces back to an inconsistency in the source case study itself (its stated SVR doesn't reconcile with its own stated MAP/CVP/CO via the standard formula), not a wiring bug.
- IntelliVue has no literal "PEA" waveform (rhythm is a fixed enum). The engine's effective-rhythm output is mapped to the closest real device rhythm (`PEA` → `sinus_tach`), with pulselessness conveyed by the flat 0/0 arterial pressure rather than a distinct waveform.

See `docs/BUILD_PROMPT.md` §9 for what Phase 3 onward looks like.

## Structure

```
engine/
  physiology.js                      # shared state model + pure transition functions (createState, applyInstant, rampState, getEffectiveRhythm)
  scenarioRunner.js                  # timeline navigation (next/prev/reset/jumpToPart) + ramp ticking + facilitator overrides
  *.test.js                          # node --test unit tests (27 passing) — zero dependencies, no build step
scenarios/
  schema.md                          # documents the unified scenario JSON format
  ct-surgery-flagship.json           # the 3-part flagship case, transcribed from docs/BUILD_PROMPT.md §4
  ct-surgery-flagship.test.js        # end-to-end test running the actual flagship JSON through the runner (8 passing)
devices/
  intellivue/
    IntelliVue_Sim_Monitor.html        # primary IntelliVue prototype — richest fidelity, has the 4-scenario CT pack
    IntelliVue_Tachy_DualScreen.html   # fork with the working pop-out (?role=learner + postMessage) pattern to port over
  hemosphere-alta/
    HemoSphere_Alta_Sim.html           # Edwards HemoSphere Alta prototype, also has the duplicate 4-scenario CT pack
  pacemaker/
    5392-pacemaker-simulator.html      # Medtronic 5392 sim — facilitator/learner/practice roles, BroadcastChannel + relay sync already built
    pace-scenarios.json                # 12 PACE-prefixed pacer scenarios
    learner-practice-data.json         # self-practice mode data (threshold trainer, fault map, MCQ bank, rubrics)
    PACEMAKER_SOURCE_README.md         # original pacemaker-sim README, kept for reference
    PACEMAKER_SOURCE_CLAUDE.md         # original pacemaker-sim CLAUDE.md, kept for reference
relay/
  server.js                            # WebSocket relay (Node + ws) — room-by-code, rebroadcasts JSON state to peers
  package.json
  README-deploy.md                     # deploy notes (written against Render; target for this project is Azure App Service, see BUILD_PROMPT.md §8.2)
docs/
  BUILD_PROMPT.md                      # the full spec — read this first
  references/                          # case study + device manuals + formulary, pulled in for the build session's convenience (some gitignored, see below)
```

## Running it today (post-Phase-2, pre-Phase-3)

Serve the repo root and open a device over `http://` (required as of Phase 2 — see above):

```bash
node serve.js
# then open:
# http://localhost:8080/devices/intellivue/IntelliVue_Sim_Monitor.html
# http://localhost:8080/devices/hemosphere-alta/HemoSphere_Alta_Sim.html
```

Open the Facilitator panel (gear icon, or press `F`) → "Shared Flagship Scenario" to drive either device through the flagship case. IntelliVue and HemoSphere Alta each run their own independent copy of the engine right now — driving one does NOT move the other yet; that's what Phase 3's sync layer adds. The pacemaker sim (`devices/pacemaker/`) is unchanged from Phase 0 and still fully standalone (`file://` still works for it, since it wasn't touched); its relay (`relay/server.js`) is the pairing mechanism Phase 3 will extend to the monitors: `npm install && node server.js` inside `relay/` lets a second pacemaker-sim window/device join over WebSocket.

To run the engine/scenario test suite (no install needed — zero dependencies):

```bash
cd engine && node --test
cd ../scenarios && node --test
```

## Source projects

- Pacemaker engine + relay ported from `~/pacemaker-sim` (git history, phase docs, and the deployed Netlify/relay snapshot live there and at `~/Claude/Projects/Knowledge Hub | Critical Care/5392 Pacemaker Simulator/`).
- IntelliVue + HemoSphere Alta prototypes ported from `~/Claude/Projects/Nurse Residency/Sim Monitors - IntelliVue & HemoSphere/`.
