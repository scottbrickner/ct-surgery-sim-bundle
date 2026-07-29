# CLAUDE.md — Medtronic 5392 Pacemaker Simulator (enhancement)

Persistent context for Claude Code. This is an ENHANCEMENT of a working single-file HTML simulator, not a rebuild. Read `docs/ENHANCEMENT_BRIEF.md` before making changes.

## What this is
A self-contained, offline-openable HTML/CSS/JS simulator of the Medtronic 5392 dual-chamber temporary external pacemaker, used to train and assess RNs on temporary pacing and troubleshooting. It has a facilitator screen and a learner screen that sync live.

## Source of truth
1. The real **Medtronic 5392** device — parameter ranges, mode set (DDD/DDI/VVI/DOO/VOO/AOO), lock and DOO emergency behavior, mA/mV steps.
2. The behavior already encoded in `5392-pacemaker-simulator.html` — treat existing clinical values as correct unless verified otherwise against Medtronic documentation.

## Non-negotiable rules
- **Single file, no build step, no runtime dependencies.** Must keep opening as a local file and running offline. (An inlined QR helper is acceptable; nothing else external for core function.)
- **Keep the 5392 faceplate photo-real.** Refine polish only; do not restyle or brand the device. Apply higher-polish visual design to the SURROUNDING surfaces (facilitator dashboard, pairing UI, coaching, strip, typography) only.
- **Do not break clinical logic:** capture, sensing, threshold testing, battery model, and the connections/circuit model (generator → 5492AL/5492VL cable → StreamLine epicardial wires → myocardium) must yield identical outcomes after changes.
- **Preserve both sync paths:** same-machine (BroadcastChannel) and two-device (WebSocket relay). Improve their UX/resilience; never remove either.
- **Learner view must never expose facilitator tools.**

## Conventions
- Vanilla HTML/CSS/JS in one file. Canvas for gauges and the ECG strip. Roles via `?role=learner` vs control. Keep code organized into clearly commented sections; keep an internal design-token block at the top for the surrounding-surface styling.
- Work in phases (see the brief). Explore and plan before editing. One phase per session; commit after each.

## Definition of done for any change
- Device look unchanged; only surrounding surfaces visibly improved.
- Clinical outcomes verified identical before vs. after (capture/sense/threshold/connections).
- No console errors or warnings; still runs as a local file; learner view is tablet- and projector-usable.

## Preview
This is a static HTML file — open `5392-pacemaker-simulator.html` in the Desktop app's preview pane (no dev server needed). Test the learner view by appending `?role=learner` to the URL.
