# CT Surgery Sim Bundle

Bundled, cross-syncing training simulation for a CT (cardiothoracic) surgery nursing class at Keck: three device simulators — **Philips IntelliVue** patient monitor, **Edwards HemoSphere Alta** hemodynamic monitor, and a **Medtronic 5392** temporary pacemaker — driven by one shared physiology engine and one facilitator console, running a single continuous cardiogenic-shock case (bedside settle-in → tamponade/arrest → ECMO cannulation).

Training simulation only. Not for clinical use.

**Full spec: [`docs/BUILD_PROMPT.md`](docs/BUILD_PROMPT.md)** — read this first. It has the reuse inventory, architecture decisions, the transcribed flagship scenario, and the phased build plan. This README just orients you in the repo; the build prompt is the source of truth.

## Status

**Phases 0-5 complete.** Phase 0 was a straight, unmodified port of three existing prototypes into one repo. Phase 1 added the shared physiology engine and the unified scenario schema. Phase 2 wired IntelliVue and HemoSphere Alta to that engine. Phase 3 made the two wired devices actually talk to each other via `sync/deviceSync.js`. Phase 4 added `facilitator/console.html`, a dedicated control page for the instructor's own laptop.

**Phase 5 wired the pacemaker into the shared engine — the pacer<->ECG feedback loop is real, not simulated-for-demo.** The pacemaker joins the same `sync/deviceSync.js` bus as an *overlay contributor*, not a scenario driver: it has no runner/flagship-case concept of its own, so it waits to receive a snapshot from a monitor or the console, patches only `state.pacer` into it from its own live, derived capture status (reusing the exact same loss-of-capture boolean logic the device's own annunciator system already relied on — not a re-derivation that could drift from it), and pushes the merged result back. Concretely verified in-browser: powering the real device on, connecting the V lead, and getting capture shows `Paced (DDD)` on IntelliVue; then raising the ventricular threshold above the output — the actual facilitator fault-injection control, not a shortcut — induces a real loss of capture, and IntelliVue's rhythm reverts to the intrinsic rhythm live, within about a push cycle (140ms in real use).

Also new in Phase 5: a shared **Training/Validation session mode**, settable from the console, that reaches the pacemaker's own pre-existing annunciator-visibility system (Validation hides its on-screen fault flags; Training shows them) — the monitors currently just carry/relay this field with no additional effect of their own (see the simplifications list below for why). And the console can now generate a `?role=learner` link for the pacemaker too, the same mechanism that already lets a monitor join from a separate device — handing a synced, fully-interactive pacer (only its own facilitator drawer hidden) to an iPad.

**The pacemaker's own pre-existing BroadcastChannel(`'sim5392'`)/relay sync — its dashboard<->learner pairing from before this repo existed — is completely untouched and runs independently alongside the new bridge.** Two separate sync systems, deliberately not merged; see CLAUDE.md if you need to reason about which is which.

**Consequence worth flagging clearly: the pacemaker can no longer be opened by double-click either.** Wiring in the shared bus required adding it a `<script type="module">` tag (its own, separate from the file's original classic script — that script is otherwise unmodified except for a small bridge object appended at its very end). Same root cause as the Phase 2 monitor change: browsers block ES module imports under `file://`. All three devices now require `node serve.js` and `http://`.

**Design call worth knowing about, carried over from Phase 4**: the per-device Facilitator panels on IntelliVue/HemoSphere Alta were not stripped down when the console was built — see the git history / CLAUDE.md if you want the full reasoning. Nothing new in Phase 5 changes that call.

Known, deliberate simplifications (documented in code comments where they occur):
- Neither monitor force-displays the engine's authored `ci`/`svr`/`svri` — both always compute Cardiac Index and (on HemoSphere) SVR/SVRI live from CO/height/weight or MAP/CVP/CO, matching how the real devices actually work (there's no field to manually enter an SVR on a real HemoSphere Alta either). The flagship case's authored `svr: 1900` for Part 3 won't match HemoSphere's own computed ~1020 — that traces back to an inconsistency in the source case study itself (its stated SVR doesn't reconcile with its own stated MAP/CVP/CO via the standard formula), not a wiring bug.
- IntelliVue has no literal "PEA" waveform (rhythm is a fixed enum). The engine's effective-rhythm output is mapped to the closest real device rhythm (`PEA` → `sinus_tach`), with pulselessness conveyed by the flat 0/0 arterial pressure rather than a distinct waveform.
- The sync payload is deliberately narrow (`{partIndex, stepIndex, state, mode}` — never `activeRamp`, since its timestamp is `performance.now()`-relative and meaningless across windows/devices). Whichever device is actively driving a ramp ticks it locally and broadcasts each already-interpolated snapshot; a follower device never runs its own ramp math, just displays incoming numbers. This also means, right now, any device (including the pacemaker's overlay) can move the shared state — there's no facilitator "lock," matching the pacemaker sim's own precedent of not needing one in practice.
- Training/Validation mode currently only has a real visual effect on the pacemaker (it has real, simulator-added coaching annunciators to hide). IntelliVue and HemoSphere Alta's alarm/annunciator text is standard real-monitor behavior, not a simulator-added teaching layer — suppressing it under "Validation" would reduce fidelity rather than help, so it deliberately doesn't.

See `docs/BUILD_PROMPT.md` §9 for what Phase 6 (Azure relay hosting, Teams-embeddable deploy, polish) looks like.

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
facilitator/
  console.html                       # standalone facilitator control page — imports engine/scenarios/sync directly, meant to run on the instructor's own laptop
devices/
  intellivue/
    IntelliVue_Sim_Monitor.html        # primary IntelliVue prototype — richest fidelity, has the 4-scenario CT pack
    IntelliVue_Tachy_DualScreen.html   # fork with the working pop-out (?role=learner + postMessage) pattern to port over
  hemosphere-alta/
    HemoSphere_Alta_Sim.html           # Edwards HemoSphere Alta prototype, also has the duplicate 4-scenario CT pack
  pacemaker/
    5392-pacemaker-simulator.html      # Medtronic 5392 sim — facilitator/learner/practice roles + its own BroadcastChannel/relay sync (untouched), plus a Phase 5 bridge into the shared engine bus (a small addition at the end of the original script + a new, separate <script type="module"> tag)
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

## Running it today (post-Phase-5, pre-Phase-6)

Serve the repo root over `http://` (required for all three devices as of Phase 5):

```bash
node serve.js
```

**Recommended way to run a full session** — open the console, both monitors, and the pacemaker, in four separate tabs/windows, **in this order** (the pacemaker only overlays onto an existing session, it can't originate one):

```
http://localhost:8080/facilitator/console.html
http://localhost:8080/devices/intellivue/IntelliVue_Sim_Monitor.html
http://localhost:8080/devices/hemosphere-alta/HemoSphere_Alta_Sim.html
http://localhost:8080/devices/pacemaker/5392-pacemaker-simulator.html
```

Drive the case from the console (Next/Prev/Part 1/2/3, override sliders, rhythm dropdown, pacer capture toggle, event flags, Training/Validation) — all three other tabs update live within a couple hundred milliseconds, zero configuration needed on one machine (BroadcastChannel). Power on the pacemaker, connect its V lead (Connections), and confirm capture — IntelliVue should show `Paced (DDD)`; raise the Ventricular threshold above the Output on the pacemaker's own facilitator panel to induce a real loss of capture and watch IntelliVue's rhythm revert live.

For a genuinely separate device (a monitor on a different laptop, the pacer on an iPad), use the console's relay URL field: paste a `wss://` endpoint, click Connect, then Copy the per-device learner link (IntelliVue, HemoSphere Alta, **or now the pacemaker**) — that URL carries the relay + session code so the device auto-joins. `relay/server.js` is the relay to point it at (`npm install && PORT=<port> node server.js` for local testing against `ws://localhost:<port>`; see `relay/README-deploy.md` for real hosting — target is Azure App Service per BUILD_PROMPT.md §8.2).

Each monitor's own Facilitator panel (gear icon, or press `F`) still works standalone too, for solo testing without the console open. The pacemaker's own Facilitator panel and its own separate learner-pairing system (unrelated to the shared session) also still work exactly as before Phase 5 — see the Status section above for the full picture of what's touched vs. untouched.

To run the full test suite (no install needed — zero dependencies, except `relay/` which needs `npm install` for its one dependency, `ws`):

```bash
cd engine && node --test
cd ../scenarios && node --test
cd ../sync && node --test
```

## Source projects

- Pacemaker engine + relay ported from `~/pacemaker-sim` (git history, phase docs, and the deployed Netlify/relay snapshot live there and at `~/Claude/Projects/Knowledge Hub | Critical Care/5392 Pacemaker Simulator/`).
- IntelliVue + HemoSphere Alta prototypes ported from `~/Claude/Projects/Nurse Residency/Sim Monitors - IntelliVue & HemoSphere/`.
