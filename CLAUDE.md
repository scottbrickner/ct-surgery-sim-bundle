# CLAUDE.md — CT Surgery Sim Bundle

Training simulation only, not for clinical use — enforce this framing in any UI copy/disclaimers.

**Read `docs/BUILD_PROMPT.md` before doing anything else in this repo.** It is the governing spec: what to reuse, the resolved architecture decisions, the transcribed flagship scenario, and the phased plan. This file only adds working conventions for whoever (human or Claude) picks up the next phase.

## Where things stand

**Phase 0** (consolidation) is done: the three device prototypes and the pacemaker's relay code are copied in **unmodified** — see README.md for the exact file map.

**Phase 1** (shared physiology engine + unified scenario schema) is done: `engine/physiology.js` + `engine/scenarioRunner.js` (35 passing `node --test` tests total, zero dependencies) and `scenarios/ct-surgery-flagship.json` (the transcribed 3-part case, validated by its own end-to-end test). Read `scenarios/schema.md` before authoring or editing scenario data.

**Devices are still NOT wired to the engine.** `engine/` and `scenarios/` are standalone modules nothing imports yet — the three device HTML files still run their own local state exactly as ported in Phase 0. Do not assume any cross-device behavior, or any device reading from the shared engine, exists until Phase 2 builds it. Phase 2 is: wire IntelliVue + HemoSphere Alta to read/write `engine/physiology.js`'s state instead of their own local sliders (BUILD_PROMPT.md §9).

A few things worth knowing before extending the engine further:
- `engine/scenarioRunner.js`'s navigation is **replay-based, not incremental**: `prev()`/`jumpToPart()`/`reset()` all recompute state from a part's `initialState` by replaying its steps (`computeStateAt`), rather than trying to invert a ramp or undo a patch. `next()` relies on the same function for whatever step it's leaving, which is *why* it can cleanly force-settle an in-flight ramp to its target before advancing — there's no separate "settle" code path to keep in sync if you add a new step type.
- Each scenario **part** has its own independent `initialState` — parts do NOT carry the previous part's ending state forward. This matches the source case study, which gives each part (SIM 1 / Scenario 2 / Scenario 3) its own fresh "Start of scenario" vitals after an off-screen time skip. If you add a 4th part, give it a complete `initialState`, don't assume it inherits Part 3's ending values.
- `bp.map` is always an independently authored field, never derived from `sbp`/`dbp` via the textbook formula — see `engine/physiology.js`'s comment and `scenarios/schema.md` for why (the source case's charted MAPs don't match the formula).
- The Part 2 `arrest` step sets `pacer.captured: false` alongside `rhythm: 'PEA'` — that's the pacer<->ECG feedback loop from BUILD_PROMPT.md §3.1 actually being exercised. If you add more arrest/capture-loss moments, remember `getEffectiveRhythm()` only reveals the intrinsic rhythm when `captured` is explicitly false; setting `rhythm` alone does nothing while `captured` stays true.

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
