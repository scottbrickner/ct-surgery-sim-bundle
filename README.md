# CT Surgery Sim Bundle

Bundled, cross-syncing training simulation for a CT (cardiothoracic) surgery nursing class at Keck: three device simulators — **Philips IntelliVue** patient monitor, **Edwards HemoSphere Alta** hemodynamic monitor, and a **Medtronic 5392** temporary pacemaker — driven by one shared physiology engine and one facilitator console, running a single continuous cardiogenic-shock case (bedside settle-in → tamponade/arrest → ECMO cannulation).

Training simulation only. Not for clinical use.

**Full spec: [`docs/BUILD_PROMPT.md`](docs/BUILD_PROMPT.md)** — read this first. It has the reuse inventory, architecture decisions, the transcribed flagship scenario, and the phased build plan. This README just orients you in the repo; the build prompt is the source of truth.

## Status

**Phase 0 and Phase 1 complete.** Phase 0 was a straight, unmodified port of three existing prototypes into one repo. Phase 1 added the shared physiology engine and the unified scenario schema, with the flagship 3-part case authored against it — but **the devices are not wired to the engine yet** (that's Phase 2). Each device HTML file still runs its own local state today; `engine/` and `scenarios/` exist alongside them as standalone, fully-tested modules, not yet imported by anything. See `docs/BUILD_PROMPT.md` §9 for what Phase 2 onward looks like.

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

## Running it today (post-Phase-1, pre-Phase-2)

Each device HTML file is still fully standalone — open any one directly in a browser, no server or build step needed. They don't talk to each other or to `engine/` yet; that wiring is Phase 2. The relay (`relay/server.js`) is the pacemaker sim's existing pairing mechanism; running it (`npm install && node server.js` inside `relay/`) lets a second pacemaker-sim window/device join over WebSocket, but the two monitor sims don't yet participate in that channel.

To run the engine/scenario test suite (no install needed — zero dependencies):

```bash
cd engine && node --test
cd ../scenarios && node --test
```

## Source projects

- Pacemaker engine + relay ported from `~/pacemaker-sim` (git history, phase docs, and the deployed Netlify/relay snapshot live there and at `~/Claude/Projects/Knowledge Hub | Critical Care/5392 Pacemaker Simulator/`).
- IntelliVue + HemoSphere Alta prototypes ported from `~/Claude/Projects/Nurse Residency/Sim Monitors - IntelliVue & HemoSphere/`.
