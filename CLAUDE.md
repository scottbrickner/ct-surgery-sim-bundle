# CLAUDE.md — CT Surgery Sim Bundle

Training simulation only, not for clinical use — enforce this framing in any UI copy/disclaimers.

**Read `docs/BUILD_PROMPT.md` before doing anything else in this repo.** It is the governing spec: what to reuse, the resolved architecture decisions, the transcribed flagship scenario, and the phased plan. This file only adds working conventions for whoever (human or Claude) picks up the next phase.

## Where things stand

Phase 0 (consolidation) is done: the three device prototypes and the pacemaker's relay code are copied in **unmodified** — see README.md for the exact file map. Nothing is wired together yet. Do not assume any cross-device behavior exists until you've built it in the phase that adds it.

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
