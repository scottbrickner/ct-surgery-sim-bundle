# CT Surgery Sim Bundle

Bundled, cross-syncing training simulation for a CT (cardiothoracic) surgery nursing class at Keck: three device simulators — **Philips IntelliVue** patient monitor, **Edwards HemoSphere Alta** hemodynamic monitor, and a **Medtronic 5392** temporary pacemaker — driven by one shared physiology engine and one facilitator console, running a single continuous cardiogenic-shock case (bedside settle-in → tamponade/arrest → ECMO cannulation).

Training simulation only. Not for clinical use.

**Full spec: [`docs/BUILD_PROMPT.md`](docs/BUILD_PROMPT.md)** — read this first. It has the reuse inventory, architecture decisions, the transcribed flagship scenario, and the phased build plan. This README just orients you in the repo; the build prompt is the source of truth.

## Status

**Phases 0-3 complete.** Phase 0 was a straight, unmodified port of three existing prototypes into one repo. Phase 1 added the shared physiology engine and the unified scenario schema, with the flagship 3-part case authored against it. Phase 2 wired IntelliVue and HemoSphere Alta to that engine, each driving its own local copy from a new "Shared Flagship Scenario" facilitator-panel section. **Phase 3 made the two wired devices actually talk to each other**: a new `sync/deviceSync.js` module (BroadcastChannel + localStorage mirror for same-machine, an opt-in WebSocket relay for real cross-device pairing) now keeps both devices' shared-engine state in lockstep — driving the scenario from either device's Facilitator panel updates the other, live. Both devices also gained a generalized `?role=learner` pop-out (hides all facilitator chrome, still syncs) via a new "Open Learner Display" button.

**The pacemaker is deliberately still not wired into any of this.** It remains exactly as ported in Phase 0 — its own mature BroadcastChannel/relay sync is untouched and unrelated to the new `sync/deviceSync.js` module. Actually cross-wiring the pacemaker's capture state into the shared physiology engine (so e.g. losing capture there visibly changes IntelliVue's rhythm) is explicitly Phase 5 territory (BUILD_PROMPT.md §9), not Phase 3 — Phase 3's scope was the monitor-to-monitor sync bus and the pop-out pattern, both done.

**Breaking change from Phase 1: IntelliVue and HemoSphere Alta can no longer be opened by double-click (`file://`).** Browsers block ES module imports (and `fetch`) from local files — each `file://` page is treated as its own opaque origin. Serve the repo root over `http://` instead: `node serve.js` (see below). The pacemaker is untouched and still opens via `file://` fine.

Known, deliberate simplifications (documented in code comments where they occur):
- Neither monitor force-displays the engine's authored `ci`/`svr`/`svri` — both always compute Cardiac Index and (on HemoSphere) SVR/SVRI live from CO/height/weight or MAP/CVP/CO, matching how the real devices actually work (there's no field to manually enter an SVR on a real HemoSphere Alta either). The flagship case's authored `svr: 1900` for Part 3 won't match HemoSphere's own computed ~1020 — that traces back to an inconsistency in the source case study itself (its stated SVR doesn't reconcile with its own stated MAP/CVP/CO via the standard formula), not a wiring bug.
- IntelliVue has no literal "PEA" waveform (rhythm is a fixed enum). The engine's effective-rhythm output is mapped to the closest real device rhythm (`PEA` → `sinus_tach`), with pulselessness conveyed by the flat 0/0 arterial pressure rather than a distinct waveform.
- The sync payload is deliberately narrow (`{partIndex, stepIndex, state}` — never `activeRamp`, since its timestamp is `performance.now()`-relative and meaningless across windows/devices). Whichever device is actively driving a ramp ticks it locally and broadcasts each already-interpolated snapshot; a follower device never runs its own ramp math, just displays incoming numbers. This also means, right now, either device can drive the scenario — there's no facilitator "lock," matching the pacemaker sim's own precedent of not needing one in practice.

See `docs/BUILD_PROMPT.md` §9 for what Phase 4 onward looks like.

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
sync/
  deviceSync.js                      # BroadcastChannel + localStorage mirror (same-machine) + WebSocket relay (cross-device) — mirrors the pacemaker's own proven sync pattern
  deviceSync.test.js                 # node --test coverage for the pure logic (genCode, dedupe, self-echo guard) — 9 passing
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

## Running it today (post-Phase-3, pre-Phase-4)

Serve the repo root and open both monitors over `http://` (required as of Phase 2 — see above):

```bash
node serve.js
# then open, in two separate tabs/windows:
# http://localhost:8080/devices/intellivue/IntelliVue_Sim_Monitor.html
# http://localhost:8080/devices/hemosphere-alta/HemoSphere_Alta_Sim.html
```

Open the Facilitator panel (gear icon, or press `F`) → "Shared Flagship Scenario" on either tab and click through Next/Part 1/2/3 — the *other* tab updates live within a couple hundred milliseconds, with zero configuration (same-machine sync is automatic via BroadcastChannel). The "Cross-Device Sync" section right below it has an "Open Learner Display" button (spawns a `?role=learner` popup with all facilitator controls hidden — drag that to a projector) and a relay URL field for pairing a genuinely separate device (a second laptop, an iPad): paste a `wss://` relay endpoint, click Connect, then Copy Learner Link to send that device a URL carrying the relay + session code. `relay/server.js` is the relay to point it at — see `relay/README-deploy.md` for hosting it (target is Azure App Service per BUILD_PROMPT.md §8.2; `PORT=<port> node server.js` after `npm install` inside `relay/` works fine for local testing against `ws://localhost:<port>`).

The pacemaker sim (`devices/pacemaker/`) is unchanged from Phase 0 and still fully standalone (`file://` still works for it) — it does not participate in any of the above; see the Status section for why.

To run the full test suite (no install needed — zero dependencies, except `relay/` which needs `npm install` for its one dependency, `ws`):

```bash
cd engine && node --test
cd ../scenarios && node --test
cd ../sync && node --test
```

## Source projects

- Pacemaker engine + relay ported from `~/pacemaker-sim` (git history, phase docs, and the deployed Netlify/relay snapshot live there and at `~/Claude/Projects/Knowledge Hub | Critical Care/5392 Pacemaker Simulator/`).
- IntelliVue + HemoSphere Alta prototypes ported from `~/Claude/Projects/Nurse Residency/Sim Monitors - IntelliVue & HemoSphere/`.
