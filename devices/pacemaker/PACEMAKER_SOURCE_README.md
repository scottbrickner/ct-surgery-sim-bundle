# Medtronic 5392 Pacemaker Simulator — Enhancement Project

Enhancing an existing, working single-file simulator: raise UI polish, harden the facilitator/learner two-screen experience, and optimize the code — without changing the device's fidelity or clinical logic.

## Start here (Claude Code Desktop)
1. Open the Claude Code Desktop app → **Code** tab → **+ New session** (Cmd+N) → **Local** → **Select folder** → choose this `pacemaker-sim` folder.
2. Set the session to **Plan mode**.
3. Open `docs/PHASE1_KICKOFF.md`, copy the kickoff, and paste it as your first prompt. It runs an **audit first** (no edits) and asks for a plan.
4. Approve the plan → work one phase at a time → commit after each.

## Preview
`5392-pacemaker-simulator.html` is a static file — open it directly in the Desktop preview pane (no dev server). Test the learner screen by adding `?role=learner` to the URL.

## What's in here
- `CLAUDE.md` — project rules + non-negotiable fidelity/clinical guardrails (auto-loaded every session).
- `5392-pacemaker-simulator.html` — the working simulator Claude Code will enhance.
- `docs/ENHANCEMENT_BRIEF.md` — the audit-first, phased enhancement plan and acceptance criteria.
- `docs/PHASE1_KICKOFF.md` — the kickoff messages.

## Golden rules
Single-file and offline-openable · keep the 5392 faceplate photo-real (polish the surrounding surfaces) · don't break capture/sense/threshold/connections logic · preserve both sync paths · learner view never shows facilitator tools · `git init` and commit after each phase.
