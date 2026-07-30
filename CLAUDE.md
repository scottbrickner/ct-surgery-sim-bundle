# CLAUDE.md — CT Surgery Sim Bundle

Training simulation only, not for clinical use — enforce this framing in any UI copy/disclaimers.

**Read `docs/BUILD_PROMPT.md` before doing anything else in this repo.** It is the governing spec: what to reuse, the resolved architecture decisions, the transcribed flagship scenario, and the phased plan. This file only adds working conventions for whoever (human or Claude) picks up the next phase.

## Where things stand

**Phase 0** (consolidation) is done: the three device prototypes and the pacemaker's relay code are copied in **unmodified** — see README.md for the exact file map.

**Phase 1** (shared physiology engine + unified scenario schema) is done: `engine/physiology.js` + `engine/scenarioRunner.js` (35 passing `node --test` tests total, zero dependencies) and `scenarios/ct-surgery-flagship.json` (the transcribed 3-part case, validated by its own end-to-end test). Read `scenarios/schema.md` before authoring or editing scenario data.

**Phase 2** (wire IntelliVue + HemoSphere Alta to the engine) is done. Both device files now `<script type="module">` import `engine/physiology.js` + `engine/scenarioRunner.js` directly and fetch `scenarios/ct-surgery-flagship.json` at load time, driving a new "Shared Flagship Scenario" facilitator-panel section. **The pacemaker is not wired**, and **the two wired devices don't sync with each other yet** — each runs its own independent in-page `runner`; that's Phase 3's job (BUILD_PROMPT.md §9: generalize pop-out + BroadcastChannel/relay sync to all three devices). Don't assume cross-device sync exists until Phase 3 builds it.

**Consequence of Phase 2: `file://` no longer works for IntelliVue or HemoSphere Alta.** Browsers block ES module imports under `file://` (opaque-origin CORS restriction) — serve the repo root over `http://` (`node serve.js`) instead. The pacemaker sim is untouched and still opens fine via `file://`.

A few things worth knowing before extending the engine or its device wiring further:
- `engine/scenarioRunner.js`'s navigation is **replay-based, not incremental**: `prev()`/`jumpToPart()`/`reset()` all recompute state from a part's `initialState` by replaying its steps (`computeStateAt`), rather than trying to invert a ramp or undo a patch. `next()` relies on the same function for whatever step it's leaving, which is *why* it can cleanly force-settle an in-flight ramp to its target before advancing — there's no separate "settle" code path to keep in sync if you add a new step type.
- Each scenario **part** has its own independent `initialState` — parts do NOT carry the previous part's ending state forward. This matches the source case study, which gives each part (SIM 1 / Scenario 2 / Scenario 3) its own fresh "Start of scenario" vitals after an off-screen time skip. If you add a 4th part, give it a complete `initialState`, don't assume it inherits Part 3's ending values.
- `bp.map` is always an independently authored field, never derived from `sbp`/`dbp` via the textbook formula — see `engine/physiology.js`'s comment and `scenarios/schema.md` for why (the source case's charted MAPs don't match the formula).
- The Part 2 `arrest` step sets `pacer.captured: false` alongside `rhythm: 'PEA'` — that's the pacer<->ECG feedback loop from BUILD_PROMPT.md §3.1 actually being exercised. If you add more arrest/capture-loss moments, remember `getEffectiveRhythm()` only reveals the intrinsic rhythm when `captured` is explicitly false; setting `rhythm` alone does nothing while `captured` stays true.
- **Per-device wiring pattern** (both files follow this identically - copy it for the pacemaker in Phase 3, don't invent a third variant): convert the file's single big `<script>` to `type="module"` (safe only because neither file uses inline `onclick=` attributes - everything's wired via `addEventListener`, confirmed before doing this); import the engine at the top; append an additive block at the bottom that (a) fetches the flagship JSON and calls `createRunner`, (b) exposes a light per-tick apply function used ONLY during a live ramp (numeric fields only, no canvas/layout calls) versus a full-apply function used on discrete Next/Prev/Reset/jump (which also refreshes tile visibility and calls the device's own `layout()`), (c) wires the vital-sign sliders to ALSO call `applyFacilitatorOverride` in addition to their existing local-state binding, and (d) exposes `window.ctSharedEngine = {getRunner, getState, getDeviceState, tickNow}` - read-only introspection used by verification tooling today and the attachment point Phase 3's sync layer should read from.
- **Why the light/full split matters**: both devices' `layout()`-equivalent function resizes/clears the canvas (`canvas.width = ...` always clears, even to the same value) as a side effect. Calling it on every animation-frame tick during a 5-minute ramp would blank the scrolling waveform 60 times a second. Only call the full apply path on discrete navigation events, never from the ramp-ticking loop.
- **`tickNow(ts)` exists because of a real testing-environment gotcha**: the Browser pane's automated tab reports `document.hidden === true`, which fully suspends `requestAnimationFrame` (a real Chrome power-saving behavior, not a bug) - so the live tick loop provably never fires during automated verification. `tickNow` lets you manually drive one tick at an explicit timestamp to test the wiring without relying on rAF. This does not affect real users with a normal foreground tab.
- **Known, deliberate display simplifications** (not bugs - see README.md for the full explanation): neither device force-displays the engine's authored `ci`/`svr`/`svri`; both always compute those live from CO/height/weight or MAP/CVP/CO, matching real device behavior. IntelliVue has no literal "PEA" rhythm morphology - `PEA` maps to `sinus_tach` with the pulselessness conveyed by flat 0/0 arterial pressure.

## Resolved decisions (do not re-litigate — see BUILD_PROMPT.md §8 for full reasoning)

- New GitHub repo, distributed to the class via a Teams/SharePoint-embedded link. Reuse the SharePoint-iframe CSP pattern already present in the pacemaker-sim's `netlify.toml` for whatever static host fronts this.
- Relay hosting target is **Azure App Service** (GitHub Pages cannot run the relay — it's static-only, no persistent process/WebSocket support). Render/Railway/Fly remain fine for local dev only.
- Build both **Training** and **Validation** modes for all three devices, matching the pacemaker sim's existing distinction.
- **No debrief/scoring screen.** Debrief is purely live-facilitated conversation after the ECMO scenario. Do not add an event log, scorecard, or coaching-summary UI for this project — that's an explicit scope cut, not an oversight.

## Architecture to build toward

- One shared physiology engine is the single source of truth (HR, rhythm, BP/MAP, PA pressures, CVP, CO/CI, SVR, SVV/PPV, ScvO₂, HPI, SpO₂, RR, temp, every drip rate, chest-tube output, pacer capture state). Devices become *views* over it — stop treating each device's local sliders as authoritative once it's wired in.
- One sync bus for everything: extend the pacemaker sim's existing BroadcastChannel (same-machine) + WebSocket relay (cross-device) mechanism to all three devices and any future iPad peer. Do not introduce a second transport (e.g. don't keep `IntelliVue_Tachy_DualScreen.html`'s raw `postMessage` — port that file's pop-out *pattern*, not its transport).
- One facilitator console driving a scripted timeline (Next/Prev/Reset through the flagship case's steps) plus free-form override sliders — not three separate side-drawers.
- Three-plus competing scenario-data formats already exist in the ported files (docx case study, duplicated CTSCN-4 pack, PACE-12 pacer library, an older LOC-11 schema). Build ONE new schema for the flagship case (BUILD_PROMPT.md §4); leave the existing packs alone as each device's own secondary/practice content rather than merging everything.

## Gotchas carried over from source projects

- The pacemaker-sim's original references folder had a literal trailing `: ` in its name (a shell-unfriendly artifact) — not reproduced here; this repo's `docs/references/` is a clean name.
- `learner-practice-data.json` and `pace-scenarios.json` are the pacemaker's own data contracts (threshold-trainer randomization, fault-action maps, rubrics) — don't repurpose their field names for the new unified scenario schema; keep them as the pacemaker's separate practice-mode library per BUILD_PROMPT.md §8.3.
- None of the three device files have a build step or npm dependencies (pure single-file HTML/CSS/JS with inline `<canvas>` rendering) — only `relay/` has a `package.json`. Don't introduce a bundler/framework without a reason tied to an actual phase's needs.
